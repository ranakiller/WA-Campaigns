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
      if (msg.action === 'ping') {
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
