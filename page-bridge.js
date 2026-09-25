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

// Polls WPP.isReady directly on an interval rather than relying on
// WPP.onReady(callback) — confirmed via a real crash report (Edge's
// extension Errors panel) that WPP.onReady is not always a function on the
// currently-vendored wa-js build/WhatsApp Web version pairing: calling it
// threw "window.WPP.onReady is not a function" as an uncaught rejection
// immediately, every time, silently killing hook installation before it
// ever got to the isReady check. This never showed up via the "ping"
// action's own status check because that one only runs after WhatsApp Web
// has already finished loading — by then WPP.isReady is already true, so
// it returns on the very first line below without ever touching
// .onReady() — but the message hooks (auto-reply, live relay) install at
// page load, when isReady still legitimately is false, so they were the
// ones actually reaching (and crashing on) that call. Polling isReady
// directly has no dependency on onReady existing at all.
async function waitForWppReady(timeoutMs = 30000) {
  if (window.WPP && window.WPP.isReady) return true;
  if (!window.WPP) return false; // vendor/wppconnect-wa.js failed to load/define WPP at all
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    if (window.WPP.isReady) return true;
  }
  return !!window.WPP.isReady;
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

    // Whatever's left is a raw WPP/internal error (e.g. "wid error: invalid
    // wid", a null-property crash) — meaningless to a user reading it in a
    // toast. Keep the original message as supporting detail, but lead with
    // something actually actionable.
    throw new Error(
      `Could not send — WhatsApp rejected it (${message}). This usually means the chat isn't fully loaded/synced yet, ` +
        `or that number/group no longer exists on WhatsApp. Try reopening that chat in WhatsApp Web once, then send again.`
    );
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
      const digits = digitsOnly(payload.number);
      // A real phone number runs roughly 7-15 digits (E.164's own cap) — a
      // wildly off length (a typo, or garbage input) is worth catching here
      // with a message that actually makes sense, rather than letting it
      // reach WPP.chat.find() and throw its own raw "wid error: invalid
      // wid", which means nothing to anyone who isn't reading this code.
      if (!digits || digits.length < 7 || digits.length > 15) {
        throw new Error("That doesn't look like a valid phone number — check the digits (and country code) and try again.");
      }
      const id = `${digits}@c.us`;
      let chat;
      try {
        chat = await window.WPP.chat.find(id);
      } catch (e) {
        throw new Error('Could not find a WhatsApp account for that number — double check the number and country code.');
      }
      if (!chat || !chat.id) throw new Error('Could not find a WhatsApp account for that number — double check the number and country code.');
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
    // Group & Contact Extractor — the group's actual WhatsApp membership,
    // not a saved list. getParticipants resolves the group then reads
    // groupMetadata.participants, giving each member's id + admin flags
    // — no display name, which is why a resolvable name below (or
    // popup.js's own chatSource cache as a second fallback) matters.
    //
    // Many groups now mask a member's real number behind an opaque
    // "@lid" (Linked ID) instead of their actual "@c.us" number — .id/
    // .number below is that lid's own digits when so, NOT a callable
    // phone number, even though it's exactly what sending a message
    // still needs to address them (that part is deliberately left
    // alone). getPnLidEntry resolves the REAL phone number (and often a
    // name) for a lid, but only from what this WhatsApp account already
    // knows locally — no live network lookup for this direction — so a
    // lid-masked stranger you have no history with can legitimately
    // resolve to nothing. That's an expected gap, not a bug.
    case 'getGroupMembers': {
      const participants = await window.WPP.group.getParticipants(payload.waId);
      const members = [];
      for (const p of participants || []) {
        const id = p.id;
        const member = {
          waId: id && id._serialized,
          number: id && id.user,
          phoneNumber: null,
          name: null,
          isAdmin: !!p.isAdmin,
          isSuperAdmin: !!p.isSuperAdmin
        };
        if (id && isLidWid(id)) {
          try {
            const entry = await window.WPP.contact.getPnLidEntry(id);
            if (entry && entry.phoneNumber && entry.phoneNumber.id) member.phoneNumber = entry.phoneNumber.id;
            if (entry && entry.contact) member.name = entry.contact.pushname || entry.contact.name || entry.contact.shortName || null;
          } catch (e) {
            // best-effort — waId/number (the lid) still work fine for sending
          }
        } else if (id) {
          member.phoneNumber = id.user; // already a real @c.us id, no resolution needed
        }
        members.push(member);
      }
      return { members };
    }
    // Chat export (Messages tab, "Export current chat" header button) —
    // returns the full message history (oldest first) for whichever chat is
    // open, as clean records ready to become chat.json, plus enough per-item
    // info (msgId/mimetype/origFilename) for background.js to download each
    // attachment on its own via the existing getMessageMedia action and save
    // it through chrome.downloads. Kept as metadata-only here rather than
    // inlining every attachment's data URL in one giant response — a chat
    // with hundreds of images would otherwise have to hold all of them in
    // memory (and cross the content.js relay) at once instead of one at a
    // time, and this shape also gives the caller a natural per-item point to
    // report live progress from.
    case 'getChatExportData': {
      const chat = window.WPP.chat.getActiveChat();
      if (!chat || !chat.id) throw new Error('No chat is currently open in WhatsApp Web — open one first.');
      // Same phoneNumber-first reasoning as getGroupMembers' lid handling —
      // a modern "@lid" chat hides the real number behind chat.contact.
      const phone = (chat.contact && chat.contact.phoneNumber && chat.contact.phoneNumber.user) || chat.id.user;
      const title = chat.formattedTitle || chat.name || '';
      let raw;
      try {
        raw = await window.WPP.chat.getMessages(chat.id._serialized, { count: -1 });
      } catch (e) {
        throw new Error(`Could not load this chat's message history (${(e && e.message) || e}).`);
      }
      raw = raw.slice().sort((a, b) => a.t - b.t);
      const me = (window.WPP.conn.getMyUserId && window.WPP.conn.getMyUserId()) ? window.WPP.conn.getMyUserId().user : 'me';
      // Group messages carry the sender as an "@lid"-or-"@c.us" wid in
      // .author — resolved the same way getGroupMembers resolves a
      // participant's real number, best-effort (local-only, no network
      // lookup — see that case's own comment on why a lid can legitimately
      // fail to resolve).
      function resolveSenderNumber(wid) {
        try {
          const c = window.WPP.whatsapp.ContactStore.get(wid);
          return (c && c.phoneNumber && c.phoneNumber.user) || (wid && wid.user);
        } catch (e) {
          return wid && wid.user;
        }
      }
      const messages = [];
      let no = 0;
      for (const m of raw) {
        // Real content only — text, a caption, or media; skips system
        // events (group name changes, etc.) and anything already deleted.
        if (!(m.mimetype || m.caption || (m.type === 'chat' && m.body))) continue;
        no++;
        const mine = !!(m.id && m.id.fromMe !== undefined ? m.id.fromMe : m.fromMe);
        const rec = {
          no,
          time: new Date(m.t * 1000).toLocaleString('sv-SE'),
          timestamp: m.t,
          number: mine ? me : m.author ? resolveSenderNumber(m.author) : phone,
          name: mine ? 'Me' : m.notifyName || chat.formattedTitle || phone,
          me: mine,
          type: m.mimetype ? m.type : 'text',
          message: (m.mimetype ? m.caption : m.body) || ''
        };
        // These three ride along only so background.js can fetch/name the
        // attachment itself — stripped back out before the final chat.json
        // is written.
        if (m.mimetype) {
          rec.msgId = m.id && m.id._serialized;
          rec.mimetype = m.mimetype;
          rec.origFilename = m.filename || null;
        }
        messages.push(rec);
      }
      return { chat: { number: phone, name: title || phone, group: !!chat.isGroup }, messages };
    }
    // Incoming feed backfill — see catchUpMissedActivity's own comment.
    case 'catchUpIncoming': {
      return await catchUpMissedActivity(payload.sinceTimestamp || 0, {
        perChatCount: payload.perChatCount,
        maxChats: payload.maxChats,
        maxEntries: payload.maxEntries
      });
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
    case 'openChat': {
      try {
        await window.WPP.chat.openChatBottom(payload.waId);
      } catch (e) {
        throw new Error("Couldn't open that chat — it may no longer exist on WhatsApp.");
      }
      return {};
    }
    // Incoming tab's "go to this message" button — WPP.chat.openChatAt
    // opens the chat scrolled to (and briefly highlighting) one specific
    // message, same as clicking a WhatsApp search result does, instead of
    // just landing at the bottom like openChat above. Only meaningful for a
    // message that's actually part of a normal chat's own history — the
    // popup already disables this button entirely for a Status/Story entry,
    // whose message lives in "status@broadcast", not the chat being opened.
    case 'openChatAtMessage': {
      try {
        await window.WPP.chat.openChatAt(payload.waId, payload.messageId);
      } catch (e) {
        throw new Error(
          "Couldn't jump to that message — it may be too old to still be loaded locally, or the chat may no longer exist on WhatsApp."
        );
      }
      return {};
    }
    // quotedMsgId (a serialized wa-js MsgKey string, e.g. from the Incoming
    // feed's inline reply) makes this render as a real WhatsApp "reply to"
    // — quoted bubble and all — instead of just landing in the chat
    // unconnected to whatever it's actually replying to. WPP.chat's send
    // functions resolve a string quotedMsg via MsgKey.fromString internally
    // and no-op the whole quoting behavior if it's falsy, so passing
    // undefined here for an ordinary (non-reply) send is safe.
    case 'sendMessage': {
      const { result, waId } = await withCommunityRedirect(payload.waId, (id) =>
        window.WPP.chat.sendTextMessage(id, payload.text, { quotedMsg: payload.quotedMsgId || undefined })
      );
      return { sent: true, msgId: result && result.id, waId: chatIdFromMsgId(result && result.id) || waId };
    }
    case 'sendMedia': {
      const { result, waId } = await withCommunityRedirect(payload.waId, (id) =>
        window.WPP.chat.sendFileMessage(id, payload.media.dataUrl, {
          type: 'auto-detect',
          caption: payload.caption || undefined,
          filename: payload.media.filename,
          mimetype: payload.media.mimeType,
          quotedMsg: payload.quotedMsgId || undefined
        })
      );
      return { sent: true, msgId: result && result.id, waId: chatIdFromMsgId(result && result.id) || waId };
    }
    // External API only (Nuskomate) — fetches a specific message's media.
    // WPP.chat.downloadMedia resolves to a Blob, not a data URL; converted
    // here so media crosses the messaging boundary the same way every other
    // attachment in this codebase already does (see sendMedia above,
    // sync.js's attachment transport).
    case 'getMessageMedia': {
      let blob;
      try {
        blob = await window.WPP.chat.downloadMedia(payload.messageId);
      } catch (e) {
        throw new Error("Couldn't download that message's media — it may have expired or been deleted.");
      }
      if (!blob) throw new Error("That message doesn't have any media.");
      // An empty download used to silently turn into a "successful" but
      // content-less data: URL — the caller would open a new tab for it and
      // see nothing at all, with no error anywhere to explain why. Seen in
      // practice on Status/Story attachments, which wa-js doesn't expose
      // the same way as a normal chat message's media.
      if (!blob.size) {
        throw new Error("Downloaded media was empty — WhatsApp Web didn't return any actual content for this attachment (seen with some Status/Story media).");
      }
      // Best-effort filename/type — a Blob alone carries no name, and the
      // exact field wa-js stores it under on the message object isn't
      // confirmed for this vendored version; falls back to empty rather
      // than guessing wrong, the caller can name the file itself if this
      // comes back blank.
      let filename = '';
      let msgType = '';
      try {
        const message = window.WPP.chat.getMessageById ? await window.WPP.chat.getMessageById(payload.messageId) : null;
        filename = (message && (message.filename || message.mediaData?.filename)) || '';
        msgType = (message && message.type) || '';
      } catch (_) {
        // best-effort only
      }
      // blob.type comes back blank for some media wa-js hasn't fully typed
      // (again, mostly Status/Story attachments) — reading a typeless Blob
      // as a data: URL bakes in an empty/generic mimetype, which is exactly
      // what makes the browser open a blank tab instead of actually
      // rendering an image/video/etc. The mimetype is part of the data: URL
      // itself at read time, not something that can be patched on
      // afterward, so a guessed one (from the message's own type) has to
      // replace it on the Blob *before* reading, not just in the response.
      const FALLBACK_MIME = {
        image: 'image/jpeg',
        video: 'video/mp4',
        ptt: 'audio/ogg',
        audio: 'audio/mpeg',
        document: 'application/pdf',
        sticker: 'image/webp'
      };
      const effectiveBlob = blob.type ? blob : new Blob([blob], { type: FALLBACK_MIME[msgType] || 'application/octet-stream' });
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the downloaded media.'));
        reader.readAsDataURL(effectiveBlob);
      });
      return { dataUrl, mimetype: effectiveBlob.type, filename };
    }
    // External API only (Nuskomate) — same send path as sendMessage above,
    // plus wa-js's mentionedList option so `mentionWaId` renders as a real
    // @mention in the group. No literal "@number" needed in payload.text —
    // that's only for wa-js's separate auto-detect mode, not used here.
    case 'mentionInChat': {
      const { result, waId } = await withCommunityRedirect(payload.waId, (id) =>
        window.WPP.chat.sendTextMessage(id, payload.text, { mentionedList: [payload.mentionWaId] })
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

// waitForWppReady() gives up after its own default 30s window — fine for a
// one-shot "ping" check, but NOT fine here: on a heavy account (hundreds of
// chats/groups), WPP can genuinely take longer than that to finish syncing,
// and if either hook below hits that timeout it previously gave up FOREVER
// — silently disabling auto-reply and the live relay for the rest of that
// tab's life, with no error surfaced anywhere and no way to recover short
// of reloading the tab again and hoping it's faster next time. Retrying
// instead of giving up fixes that: WPP.onReady() fires immediately if WPP
// is already ready by the time it's (re-)registered, so this just means
// "keep checking every 5s" rather than "wait 30s exactly once".
async function waitForWppReadyForever() {
  while (true) {
    const ready = await waitForWppReady();
    if (ready) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---------- incoming-message hook (auto-reply) ----------
// A one-way push, not a request/response round trip — background.js has no
// way to poll for new messages, so this forwards WPP's own event the
// instant it fires. `id.fromMe` filters out anything this account sent,
// including a prior auto-reply itself or a bulk campaign send.
//
// Known fixed bug: this used to take the chat from `msg.from`, on the
// assumption that a received message's chat always lives there (true for a
// 1:1, since `.from` is the other party either way) — but for a *group*
// message, `.from` is the individual participant who posted it, not the
// group. Confirmed directly: auto-reply (and the Incoming feed's reply
// button, same underlying bug — see installExternalRelayHook) was sending
// back into that participant's own 1:1 chat instead of the group the
// message actually came from. Fixed by reading the chat segment off the
// message's own id instead (chatIdFromMsgId,
// `{fromMe}_{chatId}_{uniqueId}[_participant]`), which is unambiguous
// regardless of sender or direction.
let incomingMessageHookInstalled = false;
async function installIncomingMessageHook() {
  if (incomingMessageHookInstalled) return;
  await waitForWppReadyForever();
  if (incomingMessageHookInstalled) return;
  incomingMessageHookInstalled = true;
  console.log('[WA Scheduler] auto-reply hook installed — listening for incoming messages.');
  window.WPP.on('chat.new_message', (msg) => {
    try {
      if (!msg || (msg.id && msg.id.fromMe)) return;
      const chatId = chatIdFromMsgId(msg.id._serialized) || (msg.from && (msg.from._serialized || String(msg.from)));
      if (!chatId) return;
      // .body on a media message is raw/internal, not user-facing text (see
      // installExternalRelayHook's own comment on this) — only trust it for
      // an actual plain-text message; a media message's real text (if any)
      // is its .caption.
      const text = msg.mimetype ? msg.caption || '' : msg.body || '';
      if (!text) return;
      document.dispatchEvent(
        new CustomEvent('wa-ext-notify', {
          detail: { type: 'incomingMessage', chatId, text, isGroup: !!msg.isGroupMsg, msgId: msg.id && msg.id._serialized }
        })
      );
    } catch (_) {
      // never let a malformed event break WPP's own listener chain
    }
  });
}
installIncomingMessageHook();

// ---------- incoming-message relay (external API, e.g. Nuskomate) ----------
// A second, independent subscription to the same WPP event as the hook
// above — deliberately NOT reusing it, since that one drops fromMe messages
// and anything with no text/caption (a photo or voice note with nothing
// typed alongside it), both of which an external caller reading the full
// conversation needs to see. This one passes everything through as-is and
// leaves the auto-reply hook completely untouched.
//
// buildRelayDetail is shared by the live listener below and
// catchUpMissedActivity's backfill scan further down — a message caught by
// the catch-up scan needs to come out shaped identically to one caught
// live, since they land in the exact same feed. Returns null for anything
// that shouldn't become a feed entry.
function buildRelayDetail(msg) {
  if (!msg || !msg.id) return null;
  // NOT msg.from — that's the actual sender (a group's individual
  // participant, or this account itself for anything fromMe), which only
  // happens to equal the chat for a 1:1 message received from the other
  // party. For a group message (either direction) or anything fromMe, it's
  // a different JID entirely — replying to it then went to that sender's
  // own 1:1 chat instead of back into the group it actually came
  // from/was posted to. The chat segment of the message's own id
  // (chatIdFromMsgId, `{fromMe}_{chatId}_{uniqueId}[_participant]`) is
  // unambiguous regardless of sender or direction.
  const chatId = chatIdFromMsgId(msg.id._serialized) || (msg.from && (msg.from._serialized || String(msg.from)));
  if (!chatId) return null;
  // status@broadcast (a WhatsApp Status/Story update) reports the actual
  // poster in .author, with .from itself just being the fixed broadcast id
  // — chatName falling back to that literal id told you nothing about who
  // actually posted it. Groups carry the same .author shape for their
  // individual senders too, so this is resolved unconditionally
  // (getChatExportData resolves it the same way for the same reason).
  const authorWaId = msg.author ? msg.author._serialized || String(msg.author) : null;
  let authorName = null;
  if (msg.author) {
    try {
      const c = window.WPP.whatsapp.ContactStore.get(msg.author);
      authorName = (c && (c.name || c.pushname || c.formattedName)) || null;
    } catch (_) {
      authorName = null;
    }
  }
  const isStatus = chatId === 'status@broadcast';
  const baseName = (msg.chat && (msg.chat.formattedTitle || msg.chat.name)) || chatId;
  return {
    waId: chatId,
    isGroup: !!msg.isGroupMsg,
    isStatus,
    // Who to actually open/reply to for a status entry — "chatId" here is
    // the shared broadcast id, not a real openable chat.
    authorWaId,
    // Best-effort — msg.chat isn't guaranteed to carry a resolved name on
    // every message; falls back to the raw id below. For a status, that
    // fallback is instead whoever posted it.
    chatName: isStatus ? authorName || (authorWaId && authorWaId.split('@')[0]) || 'Unknown poster' : baseName,
    fromMe: !!msg.id.fromMe,
    messageId: msg.id._serialized,
    // Passed through exactly as WPP reports it — not reinterpreted or
    // narrowed to a fixed enum, since this file has no business logic that
    // depends on the specific value.
    messageType: msg.type || 'chat',
    // Whether this message actually has a downloadable attachment — a real
    // signal (same one getChatExportData uses), not a guess from
    // messageType string-matching a fixed list, which can miss types that
    // fixed list doesn't happen to include.
    hasMedia: !!msg.mimetype,
    // .body on a media message is raw/internal data (this is what made a
    // Status image/video show up as a wall of base64-looking text before)
    // — only trust it for an actual plain-text message; a media message's
    // real text, if any, is .caption.
    text: msg.mimetype ? msg.caption || '' : msg.body || '',
    // msg.t is WhatsApp's own timestamp, in seconds; falls back to "now" on
    // the rare message that doesn't carry one.
    timestamp: msg.t ? msg.t * 1000 : Date.now()
  };
}

let externalRelayHookInstalled = false;
async function installExternalRelayHook() {
  if (externalRelayHookInstalled) return;
  await waitForWppReadyForever();
  if (externalRelayHookInstalled) return;
  externalRelayHookInstalled = true;
  console.log('[WA Scheduler] live activity relay installed — every incoming/outgoing message will now be relayed to the Incoming tab.');
  // One-way "I'm actually installed and listening" breadcrumb — reuses the
  // same wa-ext-notify channel installIncomingMessageHook already uses, so
  // content.js only needs one more `type` branch, not a whole new event.
  // Lets the popup's Incoming tab show a real installed/not-yet status
  // instead of the only signal being "have I happened to see a message
  // yet" (which can't tell "broken" apart from "just no traffic yet").
  // background.js also uses this exact signal to kick off a catch-up scan
  // (see catchUpIncomingActivity there) — it fires once per tab load,
  // which is exactly when a gap from the PC/browser having been off would
  // need backfilling.
  document.dispatchEvent(new CustomEvent('wa-ext-notify', { detail: { type: 'relayHookReady', at: Date.now() } }));
  window.WPP.on('chat.new_message', (msg) => {
    try {
      const detail = buildRelayDetail(msg);
      if (detail) document.dispatchEvent(new CustomEvent('wa-ext-relay', { detail }));
    } catch (_) {
      // never let a malformed event break WPP's own listener chain
    }
  });
}
installExternalRelayHook();

// Backfill for whatever arrived while no WhatsApp Web tab was open to catch
// it live (PC/browser off, tab closed, etc.) — requested by background.js
// (case 'catchUpIncoming' below) right after relayHookReady fires above,
// with sinceTimestamp being the newest entry it already has on file (or a
// bounded lookback on a fresh install with nothing on file yet). Chats are
// scanned newest-activity-first and the scan stops as soon as it reaches
// one that's already older than sinceTimestamp, since nothing later in that
// order can have anything newer either — keeps a normal (nothing missed)
// run cheap instead of pulling every chat's history on every single tab
// load.
// Status/Story updates are NOT in WPP.chat.list()'s scan above — confirmed
// directly in the vendored bundle: chat.list() is built entirely off
// ChatStore, which status@broadcast never enters (statuses live in their
// own, separate StatusV3Store, exposed the same way ContactStore/MsgStore
// already are elsewhere in this file, under window.WPP.whatsapp.*). Kept as
// its own function, and wrapped defensively at every step, since this store
// isn't something any existing feature in this codebase already reads from
// — if its shape doesn't match what's assumed here on some WhatsApp Web
// version, this should degrade to "no statuses this run" rather than break
// the rest of the catch-up.
function collectStatusEntries(sinceTimestamp, maxEntries) {
  const entries = [];
  let posters;
  try {
    posters = window.WPP.whatsapp.StatusV3Store.getModelsArray();
  } catch (_) {
    return entries; // this build doesn't expose the store the way expected — skip statuses, not the whole catch-up
  }
  for (const poster of posters || []) {
    if (entries.length >= maxEntries) break;
    let msgs;
    try {
      msgs = poster && poster.msgs && typeof poster.msgs.getModelsArray === 'function' ? poster.msgs.getModelsArray() : [];
    } catch (_) {
      continue;
    }
    for (const m of msgs || []) {
      if (!m || !m.t || m.t * 1000 <= sinceTimestamp) continue;
      try {
        const detail = buildRelayDetail(m);
        if (detail) entries.push(detail);
      } catch (_) {
        // one malformed status message shouldn't drop the rest
      }
    }
  }
  return entries;
}

// options lets a caller (the Incoming tab's manual "Catch up" control, via
// background.js's manualCatchUpIncoming) pull deeper/wider than the
// automatic run's defaults — up to and including sinceTimestamp: 0, which
// disables the "stop once we reach an already-covered chat" bail-out below
// entirely and scans every chat's own deep history instead.
async function catchUpMissedActivity(sinceTimestamp, options = {}) {
  const perChatCount = options.perChatCount || 50; // bounded, not the -1/full-history pull getChatExportData does
  const maxChats = options.maxChats || 40;
  const maxEntries = options.maxEntries || 200;
  let chats;
  try {
    chats = await window.WPP.chat.list();
  } catch (e) {
    throw new Error(`Could not list chats to catch up on (${(e && e.message) || e}).`);
  }
  chats = (chats || [])
    .filter((c) => c && c.id && typeof c.t === 'number')
    .sort((a, b) => b.t - a.t);
  const entries = collectStatusEntries(sinceTimestamp, maxEntries);
  for (let i = 0; i < chats.length && i < maxChats && entries.length < maxEntries; i++) {
    const chat = chats[i];
    if (chat.t * 1000 <= sinceTimestamp) break; // this chat and everything after it is already covered
    let raw;
    try {
      raw = await window.WPP.chat.getMessages(chat.id._serialized, { count: perChatCount });
    } catch (_) {
      continue; // one broken/unsynced chat shouldn't abort the whole catch-up
    }
    for (const m of raw || []) {
      if (!m || !m.t || m.t * 1000 <= sinceTimestamp) continue;
      const detail = buildRelayDetail(m);
      if (detail) entries.push(detail);
    }
  }
  entries.sort((a, b) => a.timestamp - b.timestamp); // chronological, oldest first
  return { entries: entries.slice(-maxEntries) };
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
