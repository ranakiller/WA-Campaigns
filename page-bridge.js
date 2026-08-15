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

// A WhatsApp Community is implemented as a special group (`isParentGroup`)
// paired with a same-named announcement group underneath it — WPP.chat.list()
// returns both as separate chats, which otherwise looks like a duplicate.
// Tagging the community wrapper distinctly (instead of just "group") makes
// that visible instead of confusing.
function classifyChat(c) {
  if (c.isParentGroup) return 'community';
  if (c.isGroup) return 'group';
  return 'contact';
}

async function handleRequest(action, payload) {
  switch (action) {
    case 'ping': {
      const ready = await waitForWppReady(5000);
      if (!ready) throw new Error('WPP is not ready yet (WhatsApp Web still loading, or the injected script failed).');
      return { ready: true };
    }
    case 'listChats': {
      const chats = await window.WPP.chat.list();
      return chats.map((c) => ({
        waId: c.id && c.id._serialized,
        name: c.name || c.formattedTitle || (c.id && c.id.user) || 'Unknown',
        type: classifyChat(c)
      })).filter((c) => c.waId);
    }
    case 'findContactByNumber': {
      const id = `${digitsOnly(payload.number)}@c.us`;
      const chat = await window.WPP.chat.find(id);
      if (!chat || !chat.id) throw new Error('Could not resolve that phone number to a WhatsApp contact.');
      return {
        waId: chat.id._serialized,
        name: chat.name || chat.formattedTitle || chat.id.user,
        type: classifyChat(chat)
      };
    }
    case 'sendMessage': {
      await window.WPP.chat.sendTextMessage(payload.waId, payload.text);
      return { sent: true };
    }
    case 'sendMedia': {
      await window.WPP.chat.sendFileMessage(payload.waId, payload.media.dataUrl, {
        type: 'auto-detect',
        caption: payload.caption || undefined,
        filename: payload.media.filename,
        mimetype: payload.media.mimeType
      });
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
