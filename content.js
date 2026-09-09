// content.js — isolated-world relay between background.js and page-bridge.js
// (which runs in the page's MAIN world, next to vendor/wppconnect-wa.js).
// This script deliberately does no DOM scraping or simulated clicks/typing —
// all chat listing and sending goes through WhatsApp Web's own internal API
// (window.WPP), reached via CustomEvents since isolated/MAIN worlds can't
// share JS objects directly. See page-bridge.js for the actual WPP calls.

let requestCounter = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

document.addEventListener('wa-ext-response', (event) => {
  const { id, ok, result, error } = event.detail || {};
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(result);
  else entry.reject(new Error(error || 'Unknown bridge error.'));
});

// One-way pushes from page-bridge.js (not a request/response round trip) —
// currently just a new incoming message, for the auto-reply feature. The
// service worker may be asleep; sendMessage still wakes it via its own
// onMessage listener, and the .catch() just swallows "no receiver" if
// background.js hasn't finished waking up yet — there's nothing useful to
// do about a single missed auto-reply check.
document.addEventListener('wa-ext-notify', (event) => {
  const detail = event.detail || {};
  if (detail.type === 'incomingMessage') {
    chrome.runtime
      .sendMessage({ action: 'incomingMessage', chatId: detail.chatId, text: detail.text, isGroup: detail.isGroup, msgId: detail.msgId })
      .catch(() => {});
  }
});

// ---------- privacy screen blur ----------
// Blurs WhatsApp Web's own page content (chat list names/avatars, the
// open chat's header, message text) — for screen-sharing or working
// somewhere it could be seen over your shoulder. Pure DOM/CSS, so this
// stays entirely in content.js (isolated world, has full page DOM access)
// rather than going through the page-bridge.js/window.WPP round trip
// every other feature here uses — there's no WPP API for "blur this."
//
// The selectors below (#pane-side, #main, conversation-panel-messages, plus
// the per-row ones added after) are WhatsApp Web's own internal structure,
// not something wa-js exposes a stable API for — unlike the rest of this
// extension, which deliberately avoids depending on WhatsApp Web's DOM at
// all. If a future WhatsApp Web update renames these, blur just silently
// stops covering whichever part changed (not a crash) — the sidebar/
// header/messages are separate selectors specifically so one breaking
// doesn't take out the others.
//
// The header (#main > header) is a single atomic block — hovering it to
// peek is fine as-is. The chat list and message list are each a *list* of
// many items, so blur/hover is applied per-row (cell-frame-container for
// each chat, [data-id] for each message bubble) instead of on the whole
// scrollable container — otherwise hovering anywhere in the list bubbles
// :hover up to the container and un-blurs every row at once.
const PRIVACY_BLUR_CLASS = 'wa-bulk-privacy-blur';
function ensurePrivacyBlurStyle() {
  if (document.getElementById('wa-bulk-privacy-style')) return;
  const style = document.createElement('style');
  style.id = 'wa-bulk-privacy-style';
  style.textContent = `
    html.${PRIVACY_BLUR_CLASS} #main > header,
    html.${PRIVACY_BLUR_CLASS} #pane-side [data-testid="cell-frame-container"],
    html.${PRIVACY_BLUR_CLASS} [data-testid="conversation-panel-messages"] [data-id] {
      filter: blur(6px);
      transition: filter 0.15s ease;
    }
    html.${PRIVACY_BLUR_CLASS} #main > header:hover,
    html.${PRIVACY_BLUR_CLASS} #pane-side [data-testid="cell-frame-container"]:hover,
    html.${PRIVACY_BLUR_CLASS} [data-testid="conversation-panel-messages"] [data-id]:hover {
      filter: none;
    }
  `;
  document.documentElement.appendChild(style);
}
function setPrivacyBlur(enabled) {
  ensurePrivacyBlurStyle();
  document.documentElement.classList.toggle(PRIVACY_BLUR_CLASS, !!enabled);
}
// Applies whatever was last saved the moment this script loads (a fresh
// page load doesn't otherwise know the setting) — background.js only
// pushes live updates to an already-open tab, it can't reach a tab that
// doesn't exist yet.
chrome.runtime.sendMessage({ action: 'getState' }).then((res) => {
  if (res && res.ok && res.state && res.state.settings) {
    setPrivacyBlur(!!res.state.settings.privacyBlur);
  }
}).catch(() => {});

function bridgeRequest(action, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++requestCounter}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('page-bridge.js did not respond in time (WPP may have failed to load).'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    document.dispatchEvent(new CustomEvent('wa-ext-request', { detail: { id, action, payload } }));
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === 'setPrivacyBlur') {
        setPrivacyBlur(msg.enabled);
        sendResponse({ ok: true });
      } else if (msg.action === 'ping') {
        const result = await bridgeRequest('ping', {}, 8000);
        sendResponse({ ok: true, ...result });
      } else if (msg.action === 'listChats') {
        const chats = await bridgeRequest('listChats', { scope: msg.scope, contactFilter: msg.contactFilter }, 20000);
        sendResponse({ ok: true, chats });
      } else if (msg.action === 'findContactByNumber') {
        const contact = await bridgeRequest('findContactByNumber', { number: msg.number }, 15000);
        sendResponse({ ok: true, contact });
      } else if (msg.action === 'getActiveChat') {
        const chat = await bridgeRequest('getActiveChat', {}, 10000);
        sendResponse({ ok: true, chat });
      } else if (msg.action === 'getGroupAdminInfo') {
        // Generous timeout — this checks admin status one group at a time,
        // so a large export can genuinely take a while.
        const result = await bridgeRequest('getGroupAdminInfo', { waIds: msg.waIds }, 90000);
        sendResponse({ ok: true, ...result });
      } else if (msg.action === 'getGroupMembers') {
        const result = await bridgeRequest('getGroupMembers', { waId: msg.waId }, 30000);
        sendResponse({ ok: true, ...result });
      } else if (msg.action === 'sendMessage') {
        const result = await bridgeRequest('sendMessage', { waId: msg.waId, text: msg.text }, 30000);
        sendResponse({ ok: true, ...result });
      } else if (msg.action === 'sendMedia') {
        const result = await bridgeRequest('sendMedia', { waId: msg.waId, media: msg.media, caption: msg.caption }, 45000);
        sendResponse({ ok: true, ...result });
      } else if (msg.action === 'deleteMessage') {
        const result = await bridgeRequest('deleteMessage', { waId: msg.waId, msgId: msg.msgId }, 20000);
        sendResponse({ ok: true, ...result });
      } else {
        sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
