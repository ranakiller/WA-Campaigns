// page-bridge.js — runs in the page's own JS context (MAIN world), alongside
// vendor/wppconnect-wa.js, so it can see the real `window.WPP` object.
// content.js (isolated world) can't touch window.WPP directly — the two
// worlds don't share JS objects — so they talk via CustomEvents on
// `document`, which both worlds can see since they share the same DOM.
//
// Request:  document.dispatchEvent(new CustomEvent('wa-ext-request', { detail: { id, action, payload } }))
// Response: document.dispatchEvent(new CustomEvent('wa-ext-response', { detail: { id, ok, result, error } }))

function digitsOnly(str) {
  return String(str).replace(/[^0-9]/g, '');
}

function isLidWid(id) {
  return !!(id && id.isLid && id.isLid());
}

async function waitForWppReady(timeoutMs = 30000) {
  if (window.WPP && window.WPP.isReady) return true;
  return new Promise((resolve) => {
    if (!window.WPP) {
      // vendor/wppconnect-wa.js failed to load/define WPP at all.
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    window.WPP.onReady(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// WhatsApp Web's own internal code (not this extension, not even wa-js —
// checked, the string isn't in the vendored bundle) occasionally throws
// while chat.list()/contact.list() touch per-chat encryption session state
// internally, typically for one contact/chat with an uninitialized or
// corrupted session (a very new contact, an account that hasn't fully
// synced yet, etc). There's no way to isolate which single entry did it
// from out here, so a failure is turned into an actionable message instead
// of a raw "Cannot read properties of null" dump.
async function withFriendlyFetchError(scopeLabel, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(
      `WhatsApp Web hit an internal error while listing ${scopeLabel} (${(err && err.message) || err}). ` +
        `This usually means the page hasn't fully finished syncing, or one chat/contact has a broken session on WhatsApp's end. ` +
        `Try fully reloading web.whatsapp.com, waiting until it's completely loaded, then scanning again.`
    );
  }
}

// Groups you're a member of. A WhatsApp Community is implemented as a
// special group (`isParentGroup`) paired with a same-named announcement
// group underneath it — WPP.chat.list() would return both as separate
// chats, which looked like a scan duplicate. The community wrapper itself
// is excluded here and fetched separately (fetchCommunities), so Groups and
// Communities never show the same chat twice under different scopes.
//
// `ignoreGroupMetadata: true` skips resolving each group's full metadata,
// which this only needs for `isParentGroup`/name/id anyway (none of which
// live inside that metadata) — and on some accounts one group has broken
// encryption session data that crashes WhatsApp's own metadata resolution
// (surfaces as "Cannot read properties of null (reading 'rotateKey')").
// Skipping metadata resolution here avoids touching that broken state.
async function fetchGroups() {
  const chats = await withFriendlyFetchError('groups', () =>
    window.WPP.chat.list({ onlyGroups: true, ignoreGroupMetadata: true })
  );
  return chats
    .filter((c) => !c.isParentGroup)
    .map((c) => ({
      waId: c.id && c.id._serialized,
      name: c.name || c.formattedTitle || (c.id && c.id.user) || 'Unknown',
      type: 'group',
      number: ''
    }))
    .filter((c) => c.waId);
}

// Your actual WhatsApp contacts (phone address book WhatsApp synced), not
// just people you happen to already have an open chat with.
//
// WhatsApp gives each contact both a phone-number identity (@c.us) and a
// privacy "LID" identity (@lid, used to mask the number from other people
// in shared groups) — contact.list() returns both as separate entries for
// the same person, which otherwise shows up as an exact-looking duplicate.
// For your own saved contacts the @c.us identity is always the one you
// actually have, so @lid twins are dropped here.
async function fetchContacts() {
  const contacts = await withFriendlyFetchError('contacts', () => window.WPP.contact.list({ onlyMyContacts: true }));
  return contacts
    .filter((c) => !c.isMe && !isLidWid(c.id))
    .map((c) => ({
      waId: c.id && c.id._serialized,
      name: c.name || c.pushname || c.shortName || (c.id && c.id.user) || 'Unknown',
      type: 'contact',
      number: (c.id && c.id.user) || ''
    }))
    .filter((c) => c.waId);
}

// Community wrapper chats themselves — separate from their announcement
// group (which shows up under Groups) so nothing gets silently skipped.
// Same ignoreGroupMetadata reasoning as fetchGroups above.
async function fetchCommunities() {
  const chats = await withFriendlyFetchError('communities', () =>
    window.WPP.chat.list({ onlyCommunities: true, ignoreGroupMetadata: true })
  );
  return chats
    .map((c) => ({
      waId: c.id && c.id._serialized,
      name: c.name || c.formattedTitle || (c.id && c.id.user) || 'Unknown',
      type: 'community',
      number: ''
    }))
    .filter((c) => c.waId);
}

// Individual (1:1) conversations, whether or not the other person is saved
// in your address book — useful for reaching people who've messaged you but
// were never added as a contact. `isSavedContact` lets the popup filter.
async function fetchIndividualChats() {
  const [chats, myContacts] = await withFriendlyFetchError('chats', () =>
    Promise.all([window.WPP.chat.list({ onlyUsers: true }), window.WPP.contact.list({ onlyMyContacts: true })])
  );
  const myContactIds = new Set(
    myContacts.filter((c) => !isLidWid(c.id)).map((c) => c.id && c.id._serialized)
  );
  return chats
    .map((c) => ({
      waId: c.id && c.id._serialized,
      name: c.name || c.formattedTitle || (c.id && c.id.user) || 'Unknown',
      type: 'contact',
      number: (c.id && c.id.user) || '',
      isSavedContact: myContactIds.has(c.id && c.id._serialized)
    }))
    .filter((c) => c.waId);
}

// A WhatsApp Community's own chat can never receive a direct message — only
// its Announcement Group can. For text sends WhatsApp rejects with an error
// naming the correct target ("...Correct announcement groupId: X@g.us"),
// which is enough to retry against on its own — but a rejected *file* send
// doesn't throw at all, it just silently resolves without delivering
// anything, so there's no error here to react to. The resolver below finds
// the announcement group proactively (its own metadata records which
// community it belongs to, and that it's the announcement group) so both
// send paths can be redirected up front instead of reacting after the fact.
const COMMUNITY_REDIRECT_RE = /correct announcement groupid:\s*([\d.\-]+@g\.us)/i;

function widToString(wid) {
  if (!wid) return null;
  return wid._serialized || (typeof wid.toString === 'function' ? wid.toString() : String(wid));
}

// Both this and findGroupByWaId below need the real per-group metadata
// (.announce, .parentGroup) to do their job, so unlike the scan-time
// fetchGroups/fetchCommunities they can't just pass ignoreGroupMetadata to
// dodge a broken group elsewhere in the account — the fix here is making
// sure that failure only disables the *enhancement* (community redirect /
// admin-only check) instead of blocking the send that triggered it. This
// was the actual bug behind sends failing on every item: chat.list()
// crashing here happened *before* the try/catch that has the rotateKey
// retry logic even ran, so that recovery path was never reached.
async function listGroupsWithMetadata() {
  try {
    return await window.WPP.chat.list({ onlyGroups: true });
  } catch (e) {
    return null; // signals "couldn't resolve — skip the enhancement, don't block the send"
  }
}

async function resolveCommunitySendTarget(waId) {
  let chat = null;
  try {
    // chat.get() is synchronous (returns the chat or undefined directly,
    // not a Promise) — awaiting a non-promise value is safe, but chaining
    // .catch() onto it isn't, since there's nothing thenable to chain onto.
    chat = window.WPP.chat.get(waId);
  } catch (e) {
    chat = null;
  }
  if (!chat || !chat.isParentGroup) return waId; // not a community wrapper — send as-is

  const groups = await listGroupsWithMetadata();
  if (!groups) return waId; // couldn't check — send to the original id as-is
  const announceGroup = groups.find((g) => {
    const meta = g.groupMetadata;
    if (!meta || !meta.announce) return false;
    return widToString(meta.parentGroup) === waId;
  });
  return (announceGroup && announceGroup.id && announceGroup.id._serialized) || waId;
}

async function findGroupByWaId(waId) {
  const groups = await listGroupsWithMetadata();
  if (!groups) return null;
  return groups.find((g) => g.id && g.id._serialized === waId) || null;
}

// A group with posting locked to admins ("Only admins can send messages")
// silently accepts a send from a non-admin the same way a community wrapper
// does — it resolves without delivering anything. Checked up front so it
// fails loudly (and gets logged) instead of looking like a real send.
async function assertCanPostToGroup(waId) {
  const group = await findGroupByWaId(waId);
  if (!group || !group.groupMetadata || !group.groupMetadata.announce) return;
  const isAdmin = await window.WPP.group.iAmAdmin(waId).catch(() => false);
  if (!isAdmin) {
    throw new Error(
      "Only admins can post in this group and you're not an admin here — skipped rather than silently failing."
    );
  }
}

// Sending programmatically via sendTextMessage/sendFileMessage never
// "opens" the chat the way clicking it in the real UI does. On at least one
// (freshly-linked) account, a chat whose local encryption session hadn't
// been established yet threw "Cannot read properties of null (reading
// 'rotateKey')" on send — opening the chat first (mirroring what a human
// does) is what establishes it. But most sends never hit this, so it's only
// done reactively, after a first attempt actually fails this way — not on
// every send, which would add a real, constant delay for no benefit most
// of the time.
const ROTATE_KEY_ERROR_RE = /reading ['"]rotateKey['"]/i;

async function openChatBeforeSend(waId) {
  try {
    await window.WPP.chat.openChatBottom(waId);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let it settle
  } catch (e) {
    // proceed to the retry regardless
  }
}

async function withCommunityRedirect(waId, sendFn) {
  const resolvedId = await resolveCommunitySendTarget(waId);
  await assertCanPostToGroup(resolvedId);
  try {
    return await sendFn(resolvedId);
  } catch (err) {
    const message = String((err && err.message) || err);

    const communityMatch = message.match(COMMUNITY_REDIRECT_RE);
    if (communityMatch) {
      await assertCanPostToGroup(communityMatch[1]);
      return sendFn(communityMatch[1]);
    }

    if (ROTATE_KEY_ERROR_RE.test(message)) {
      await openChatBeforeSend(resolvedId);
      return sendFn(resolvedId); // let this one's error (if any) propagate as-is
    }

    throw err;
  }
}

async function handleRequest(action, payload) {
  switch (action) {
    case 'ping': {
      const ready = await waitForWppReady(5000);
      if (!ready) throw new Error('WPP is not ready yet (WhatsApp Web still loading, or the injected script failed).');
      return { ready: true };
    }
    case 'listChats': {
      const scope = payload.scope || 'groups';
      if (scope === 'chats') {
        const chats = await fetchIndividualChats();
        const filter = payload.contactFilter || 'all';
        if (filter === 'contacts') return chats.filter((c) => c.isSavedContact);
        if (filter === 'noncontacts') return chats.filter((c) => !c.isSavedContact);
        return chats;
      }
      const all = scope === 'all';
      const [groups, contacts, communities] = await Promise.all([
        all || scope === 'groups' ? fetchGroups() : [],
        all || scope === 'contacts' ? fetchContacts() : [],
        all || scope === 'communities' ? fetchCommunities() : []
      ]);
      return [...groups, ...contacts, ...communities];
    }
    case 'findContactByNumber': {
      const id = `${digitsOnly(payload.number)}@c.us`;
      const chat = await window.WPP.chat.find(id);
      if (!chat || !chat.id) throw new Error('Could not resolve that phone number to a WhatsApp contact.');
      return {
        waId: chat.id._serialized,
        name: chat.name || chat.formattedTitle || chat.id.user,
        type: chat.isGroup ? 'group' : 'contact',
        number: chat.isGroup ? '' : chat.id.user || ''
      };
    }
    case 'getActiveChat': {
      const chat = window.WPP.chat.getActiveChat();
      if (!chat || !chat.id) {
        throw new Error('No chat is currently open in WhatsApp Web — open one first.');
      }
      return {
        waId: chat.id._serialized,
        name: chat.name || chat.formattedTitle || chat.id.user
      };
    }
    case 'sendMessage': {
      await withCommunityRedirect(payload.waId, (id) => window.WPP.chat.sendTextMessage(id, payload.text));
      return { sent: true };
    }
    case 'sendMedia': {
      await withCommunityRedirect(payload.waId, (id) =>
        window.WPP.chat.sendFileMessage(id, payload.media.dataUrl, {
          type: 'auto-detect',
          caption: payload.caption || undefined,
          filename: payload.media.filename,
          mimetype: payload.media.mimeType
        })
      );
      return { sent: true };
    }
    default:
      throw new Error(`Unknown bridge action: ${action}`);
  }
}

document.addEventListener('wa-ext-request', async (event) => {
  const { id, action, payload } = event.detail || {};
  try {
    const result = await handleRequest(action, payload || {});
    document.dispatchEvent(new CustomEvent('wa-ext-response', { detail: { id, ok: true, result } }));
  } catch (err) {
    document.dispatchEvent(
      new CustomEvent('wa-ext-response', { detail: { id, ok: false, error: String(err && err.message ? err.message : err) } })
    );
  }
});
