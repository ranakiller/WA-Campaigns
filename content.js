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
// The selectors below are WhatsApp Web's own internal structure, not
// something wa-js exposes a stable API for — unlike the rest of this
// extension, which deliberately avoids depending on WhatsApp Web's DOM at
// all. Split into one entry per privacyBlurOptions category (see
// background.js's DEFAULT_SETTINGS) so each can be toggled independently —
// if WhatsApp renames one of these, that one category just silently stops
// blurring rather than anything breaking. Confidence varies: `img`
// (profilePictures) and `.selectable-text` (messages) are long-standing,
// widely-relied-on selectors; the data-testid/dir=auto ones are a
// reasonable best effort, not verified against a live build.
//
// Each rule's `row` is what :hover reveals (a single chat/message/the
// header), `target` is the actual element blurred inside it — hovering the
// row un-blurs only the categories currently turned on within it, not the
// whole row at once, so an off category never flashes into view on hover.
const PRIVACY_BLUR_CLASS = 'wa-bulk-privacy-blur';
const PRIVACY_BLUR_RULES = {
  profilePictures: [
    { row: '#pane-side [data-testid="cell-frame-container"]', target: 'img' },
    { row: '#main > header', target: 'img' }
  ],
  chatListNames: [
    { row: '#pane-side [data-testid="cell-frame-container"]', target: '[data-testid="cell-frame-title"]' },
    { row: '#main > header', target: 'span[dir="auto"][title]' }
  ],
  // Excludes the title span itself so this doesn't just re-blur the name a
  // second time — everything else dir=auto in the row (the last-message
  // preview line, mainly) is fair game.
  chatListPreviews: [{ row: '#pane-side [data-testid="cell-frame-container"]', target: 'span[dir="auto"]:not([data-testid="cell-frame-title"])' }],
  // .selectable-text alone missed real content in testing — forwarded/quoted
  // previews, contact-card names, and similar sub-elements inside a message
  // aren't always marked .selectable-text, but WhatsApp wraps essentially
  // all of its own user-facing text (bidi-aware) in a dir="ltr"/"auto"
  // attribute regardless of which specific element renders it, so that's
  // the broader, more reliable net.
  messages: [{ row: '[data-testid="conversation-panel-messages"] [data-id]', target: '.selectable-text, [dir="ltr"], [dir="auto"]' }],
  media: [{ row: '[data-testid="conversation-panel-messages"] [data-id]', target: 'img, video' }]
};
const DEFAULT_PRIVACY_BLUR_OPTIONS = {
  style: 'blur',
  categories: {
    messages: { enabled: true, intensity: 60 },
    media: { enabled: true, intensity: 60 },
    chatListNames: { enabled: true, intensity: 60 },
    chatListPreviews: { enabled: true, intensity: 60 },
    profilePictures: { enabled: true, intensity: 60 }
  }
};
// A shallow spread would replace the whole `categories` object wholesale if
// present at all, silently dropping any category the caller's copy doesn't
// know about yet (e.g. after this extension adds a 6th one) — merge each
// category against its own default instead.
function mergePrivacyBlurOptions(options) {
  const incoming = options || {};
  const categories = {};
  for (const key of Object.keys(DEFAULT_PRIVACY_BLUR_OPTIONS.categories)) {
    categories[key] = { ...DEFAULT_PRIVACY_BLUR_OPTIONS.categories[key], ...((incoming.categories || {})[key] || {}) };
  }
  return { style: incoming.style === 'blackout' ? 'blackout' : 'blur', categories };
}
// blur: intensity 0-100 maps to a 2px-20px blur radius. blackout: intensity
// maps to how opaque the solid black cover sits over the (otherwise
// untouched) text/image — 35%-100% opacity, never fully see-through even at
// 0, since a barely-there redaction bar isn't much of a redaction. Revealing
// on hover is just removing whichever property this sets — no need to
// capture/restore WhatsApp's own original color, this never touches it.
function effectCss(style, intensity) {
  const pct = Math.max(0, Math.min(100, Number(intensity) || 0)) / 100;
  if (style === 'blackout') {
    const opacity = (0.35 + pct * 0.65).toFixed(2);
    return { on: `background-color: rgba(0,0,0,${opacity}) !important; border-radius: 2px;`, off: 'background-color: transparent !important;' };
  }
  const px = (2 + pct * 18).toFixed(1);
  return { on: `filter: blur(${px}px);`, off: 'filter: none;' };
}
function buildPrivacyBlurCss(options) {
  const opts = mergePrivacyBlurOptions(options);
  let css = '';
  for (const [key, rules] of Object.entries(PRIVACY_BLUR_RULES)) {
    const cat = opts.categories[key];
    if (!cat || !cat.enabled) continue;
    const { on, off } = effectCss(opts.style, cat.intensity);
    for (const { row, target } of rules) {
      css += `html.${PRIVACY_BLUR_CLASS} ${row} ${target} { ${on} transition: filter 0.15s ease, background-color 0.15s ease; }\n`;
      css += `html.${PRIVACY_BLUR_CLASS} ${row}:hover ${target} { ${off} }\n`;
    }
  }
  return css;
}
function ensurePrivacyBlurStyleEl() {
  let style = document.getElementById('wa-bulk-privacy-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'wa-bulk-privacy-style';
    document.documentElement.appendChild(style);
  }
  return style;
}
function setPrivacyBlur(enabled, options) {
  ensurePrivacyBlurStyleEl().textContent = buildPrivacyBlurCss(options);
  document.documentElement.classList.toggle(PRIVACY_BLUR_CLASS, !!enabled);
}
// Applies whatever was last saved the moment this script loads (a fresh
// page load doesn't otherwise know the setting) — background.js only
// pushes live updates to an already-open tab, it can't reach a tab that
// doesn't exist yet.
chrome.runtime.sendMessage({ action: 'getState' }).then((res) => {
  if (res && res.ok && res.state && res.state.settings) {
    setPrivacyBlur(!!res.state.settings.privacyBlur, res.state.settings.privacyBlurOptions);
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
        setPrivacyBlur(msg.enabled, msg.options);
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
