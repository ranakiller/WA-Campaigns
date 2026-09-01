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

// WhatsApp message ids are formatted `{fromMe}_{chatId}_{uniqueId}` (a group
// message adds a trailing `_{participant}`, which this ignores) — the
// chat-id segment is ground truth for which chat a message actually lives
// in, which for an individual contact can differ from whatever id was used
// to *address* the send (WhatsApp can silently resolve a phone-number-based
// @c.us id to that contact's @lid identity when actually sending, the same
// way a community's wrapper id gets redirected to its announcement group —
// see withCommunityRedirect below). Deleting later needs the chat the
// message truly lives in, not the id it was originally sent to, so this is
// used to correct `waId` right after every send rather than trusting the
// input id.
function chatIdFromMsgId(msgId) {
  if (typeof msgId !== 'string') return null;
  const parts = msgId.split('_');
  return parts.length >= 2 ? parts[1] : null;
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
      // formattedTitle first: after a group rename, a stale/duplicate chat
      // object can linger with the old text still cached in .name while
      // formattedTitle is already current on every chat object, live or
      // stale — .name is only the fallback for the rare case it's missing.
      name: c.formattedTitle || c.name || (c.id && c.id.user) || 'Unknown',
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
      // Same formattedTitle-first reasoning as fetchGroups above.
      name: c.formattedTitle || c.name || (c.id && c.id.user) || 'Unknown',
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

// Returns { result, waId } rather than just the raw send result — the chat
// a message actually lands in can differ from the one originally requested
// (community redirect, see below), and callers that need to reference the
// sent message later (delete-for-everyone) need to know exactly which chat
// it's really sitting in, not just where the caller thought it was going.
async function withCommunityRedirect(waId, sendFn) {
  const resolvedId = await resolveCommunitySendTarget(waId);
  await assertCanPostToGroup(resolvedId);
  try {
    return { result: await sendFn(resolvedId), waId: resolvedId };
  } catch (err) {
    const message = String((err && err.message) || err);

    const communityMatch = message.match(COMMUNITY_REDIRECT_RE);
    if (communityMatch) {
      await assertCanPostToGroup(communityMatch[1]);
      return { result: await sendFn(communityMatch[1]), waId: communityMatch[1] };
    }

    if (ROTATE_KEY_ERROR_RE.test(message)) {
      await openChatBeforeSend(resolvedId);
      return { result: await sendFn(resolvedId), waId: resolvedId }; // let this one's error (if any) propagate as-is
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
    // For the CSV export's "You're Admin" / "Admin-Only Group" columns.
    // Admin status is checked per group (WPP.group.iAmAdmin — the same
    // safe, individually-catchable call assertCanPostToGroup already uses)
    // so one broken group can't affect any other row. Announce (admin-only)
    // status needs real group metadata, which only comes back from a single
    // batched fetch (listGroupsWithMetadata) — if that fails (the same
    // broken-encryption-session crash risk noted on that helper), every
    // row's Admin-Only column comes back blank rather than the whole
    // export failing; the admin column is unaffected either way.
    case 'getGroupAdminInfo': {
      const waIds = payload.waIds || [];
      const info = {};
      for (const waId of waIds) {
        let isAdmin = null;
        try {
          isAdmin = await window.WPP.group.iAmAdmin(waId);
        } catch (e) {
          isAdmin = null;
        }
        info[waId] = { isAdmin, announceOnly: null };
      }
      const groups = await listGroupsWithMetadata();
      if (groups) {
        for (const g of groups) {
          const id = g.id && g.id._serialized;
          if (id && info[id]) {
            info[id].announceOnly = !!(g.groupMetadata && g.groupMetadata.announce);
          }
        }
      }
      return { info };
    }
    case 'getActiveChat': {
      const chat = window.WPP.chat.getActiveChat();
      if (!chat || !chat.id) {
        throw new Error('No chat is currently open in WhatsApp Web — open one first.');
      }
      return {
        waId: chat.id._serialized,
        // formattedTitle first — see fetchGroups' comment; the open chat
        // could be a renamed group with a stale .name too.
        name: chat.formattedTitle || chat.name || chat.id.user
      };
    }
    case 'sendMessage': {
      const { result, waId } = await withCommunityRedirect(payload.waId, (id) => window.WPP.chat.sendTextMessage(id, payload.text));
      return { sent: true, msgId: result && result.id, waId: chatIdFromMsgId(result && result.id) || waId };
    }
    case 'sendMedia': {
      const { result, waId } = await withCommunityRedirect(payload.waId, (id) =>
        window.WPP.chat.sendFileMessage(id, payload.media.dataUrl, {
          type: 'auto-detect',
          caption: payload.caption || undefined,
          filename: payload.media.filename,
          mimetype: payload.media.mimeType
        })
      );
      return { sent: true, msgId: result && result.id, waId: chatIdFromMsgId(result && result.id) || waId };
    }
    // "Delete for everyone" — WhatsApp only allows this within a limited
    // time window after sending and only for messages sent by this account;
    // past that it throws or comes back with isRevoked:false, which the
    // caller (background.js) reports per-message rather than treating as a
    // hard failure that stops the rest of a bulk delete.
    //
    // A verify-and-retry step was tried here (re-checking the message's own
    // state a moment later, retrying the revoke if it didn't look confirmed
    // yet) to guard against WPP resolving isRevoked:true before WhatsApp's
    // server has actually processed it. In testing that made things worse,
    // not better — confirmed via WhatsApp Web's own console that a single
    // direct call reliably works (including on individual/@lid chats, which
    // the retry path was specifically breaking), so trust the one call's own
    // result rather than second-guessing it.
    //
    // Passing an array of message ids to WPP.chat.deleteMessage() was also
    // tried, on the assumption it'd send one combined revoke command for a
    // whole chat. Decompiling the actual implementation showed that's wrong
    // — it just loops internally and fires one separate revoke send per
    // message anyway, with *no* pacing between them at all, which is worse
    // than doing it ourselves one at a time with a real gap between each.
    // So this stays one message per call, and pacing (see the delay between
    // deletes in runDeleteForEveryone, background.js) is the real mitigation
    // for a silent miss, not batching.
    case 'deleteMessage': {
      const outcome = await window.WPP.chat.deleteMessage(payload.waId, payload.msgId, false, true);
      const r = Array.isArray(outcome) ? outcome[0] : outcome;
      return { isRevoked: !!(r && r.isRevoked), isDeleted: !!(r && r.isDeleted) };
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
