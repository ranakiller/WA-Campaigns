function call(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (res) => resolve(res || { ok: false, error: 'No response' }));
  });
}

let STATE = { fetchedChats: [], lists: [], messages: [], campaigns: [], log: [], settings: {}, activeRuns: {} };
// Which "send now" run (a background.js activeRuns id) belongs to which
// saved message, so the send panel can show that message's own progress
// bar instead of a generic one — populated when sendNow() returns its runId.
// Persisted (same pattern as lastTab) so closing/reopening the popup
// mid-send doesn't lose track of it. assignedAt gives a short grace window
// right after sending, before background.js has necessarily written the
// run's storage record yet — without it there's no way to tell "not
// created yet" apart from "long finished and pruned", so a fresh mapping
// could get wiped before the real data ever arrives.
const messageRunIds = new Map(); // messageId -> { runId, assignedAt }
function saveMessageRunIds() {
  chrome.storage.local.set({ messageRunIds: Object.fromEntries(messageRunIds) });
}
chrome.storage.local.get(['messageRunIds'], (data) => {
  for (const [msgId, entry] of Object.entries(data.messageRunIds || {})) {
    if (entry && entry.runId) messageRunIds.set(msgId, entry);
  }
});
// The message currently being composed/edited — an ordered sequence of
// items, each independently text or media(+its own caption). Sent one after
// another to each chat before the campaign moves on to the next chat.
let composingItems = []; // { kind: 'text', text } | { kind: 'media', media, caption }
let editingMessageId = null;
let editingListId = null;
let editingCampaignId = null;

// The divider checkbox appears in two independent places (the one-off Send
// panel, and the campaign form) — each remembers its own last-used state
// across popup opens, not tied to any one message/campaign. Loaded once
// here (async), with a re-render once it resolves so anything already
// painted with the checkbox's hardcoded default picks up the real value.
let sendPanelDividerPref = true;
let campaignDividerPref = true;
chrome.storage.local.get(['sendPanelDividerPref', 'campaignDividerPref'], (data) => {
  if (data.sendPanelDividerPref !== undefined) sendPanelDividerPref = data.sendPanelDividerPref;
  if (data.campaignDividerPref !== undefined) campaignDividerPref = data.campaignDividerPref;
  refresh();
});

// Chats seen via scan/manual-add. Backed by chrome.storage (STATE.fetchedChats)
// so they survive the popup closing — refresh() merges storage into this map
// on every load; "Clear fetched" is the only thing that empties it.
let chatSource = new Map(); // waId -> { waId, name, type, number }
let selectedWaIds = new Set();
let listSearchQuery = '';

const EXPORT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm0 2h5v4H5V5Zm7 0h7v4h-7V5ZM5 11h5v3H5v-3Zm7 0h7v3h-7v-3ZM5 16h5v3H5v-3Zm7 0h7v3h-7v-3Z"/></svg>';
const EDIT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
const DELETE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg>';
const PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const RUN_NOW_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>';
const RESET_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>';

function renderProgressBlock(run) {
  const doneCount = run.sent + run.failed;
  const pct = run.total > 0 ? Math.round((doneCount / run.total) * 100) : 0;
  const fillClass = run.failed > 0 ? 'progress-fill has-failures' : 'progress-fill';
  const status = run.done
    ? `<span class="progress-label done">Finished — ${run.sent} sent${run.failed ? `, ${run.failed} failed` : ''}</span>`
    : `<span class="progress-label">${run.paused ? 'Paused — ' : ''}${doneCount}/${run.total} (${pct}%) — ${run.sent} sent${run.failed ? `, ${run.failed} failed` : ''}, ${run.total - doneCount} pending</span>`;
  // Pause/resume and reset are wired via a delegated document-level click
  // listener (see below) rather than per-render, since this HTML is
  // inserted via innerHTML from two different places (message send panel,
  // campaign row).
  const controls = !run.done
    ? `<button class="icon-btn small-icon-btn progress-pause-btn" type="button" data-run-id="${run.id}" title="${run.paused ? 'Resume' : 'Pause'}">${run.paused ? PLAY_ICON_SVG : PAUSE_ICON_SVG}</button>
       <button class="icon-btn small-icon-btn danger progress-reset-btn" type="button" data-run-id="${run.id}" title="Reset (stop and clear this run — doesn't re-send to chats already reached)">${RESET_ICON_SVG}</button>`
    : '';
  return `<div class="progress-block">
    <div class="progress-bar-row">
      <div class="progress-bar"><div class="${fillClass}" style="width:${pct}%"></div></div>
      ${controls}
    </div>
    ${status}
  </div>`;
}

document.addEventListener('click', async (e) => {
  const pauseBtn = e.target.closest('.progress-pause-btn');
  if (pauseBtn) {
    await call('togglePauseRun', { runId: pauseBtn.dataset.runId });
    return;
  }
  const resetBtn = e.target.closest('.progress-reset-btn');
  if (resetBtn) {
    if (!confirm("Reset this run? It stops sending the rest — chats already reached won't be re-sent to.")) return;
    await call('resetRun', { runId: resetBtn.dataset.runId });
  }
});

function downloadCsv(filename, chats) {
  const escapeCsv = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Name', 'Type', 'ID / Number'];
  const rows = (chats || []).map((c) => [c.name, c.type, c.type === 'contact' ? c.number || c.waId : c.waId]);
  const csv = [header, ...rows].map((r) => r.map(escapeCsv).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function refresh() {
  const res = await call('getState');
  if (res.ok) STATE = res.state;
  for (const c of STATE.fetchedChats || []) {
    chatSource.set(c.waId, c);
  }
  applyTheme();
  renderMasterToggle();
  renderMessages();
  renderListBuilder();
  renderLists();
  renderCampaignForm();
  renderCampaignList();
  renderLog();
  renderSettings();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function secToMs(sec, fallback) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallback;
}

// ---------- theme ----------
function applyTheme() {
  const theme = STATE.settings.theme || 'system';
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

document.getElementById('themeToggleBtn').addEventListener('click', async () => {
  const order = ['system', 'light', 'dark'];
  const current = STATE.settings.theme || 'system';
  const next = order[(order.indexOf(current) + 1) % order.length];
  await call('saveSettings', { settings: { theme: next } });
  refresh();
});

// ---------- master on/off switch ----------
// Instant kill switch: off blocks any new send from starting and stops a
// run already in progress (background.js checks this before every single
// item, not just at the start of a campaign).
function renderMasterToggle() {
  const enabled = STATE.settings.masterEnabled !== false;
  document.getElementById('masterToggleBtn').classList.toggle('off', !enabled);
  document.getElementById('masterToggleBtn').title = enabled ? 'Turn the extension off' : 'Turn the extension on';
  document.getElementById('masterOffBanner').style.display = enabled ? 'none' : '';
}

document.getElementById('masterToggleBtn').addEventListener('click', async () => {
  const enabled = STATE.settings.masterEnabled !== false;
  if (enabled) {
    if (!confirm('Turn the extension off? This immediately stops any campaign or send in progress.')) return;
  }
  await call('saveSettings', { settings: { masterEnabled: !enabled } });
  refresh();
});

// ---------- tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    chrome.storage.local.set({ lastTab: btn.dataset.tab });
  });
});

chrome.storage.local.get(['lastTab'], (data) => {
  if (data.lastTab) {
    const btn = document.querySelector(`.tab-btn[data-tab="${data.lastTab}"]`);
    if (btn) btn.click();
  }
});

// ============ MESSAGES ============
// A message is an ordered list of items (composingItems while being built).
// The paperclip attaches a file as its own item immediately (caption edited
// inline afterward); the + button adds the current textarea content as a
// separate text item. Nothing is "the" message until Save is pressed.

let openSendPanelMessageId = null; // only one "send now" panel open at a time

// The in-progress compose form (label, text box, staged items) is a popup
// UI concern, not core app data — same pattern as lastTab — so it's read
// and written directly via chrome.storage.local rather than round-tripping
// through background.js. Without this, closing the popup (which destroys
// its JS state entirely) would silently discard an unsaved draft.
function saveDraft() {
  chrome.storage.local.set({
    messageDraft: {
      label: document.getElementById('msgLabel').value,
      srNo: document.getElementById('msgSrNo').value,
      text: document.getElementById('msgText').value,
      items: composingItems,
      editingMessageId
    }
  });
}

function clearDraft() {
  chrome.storage.local.remove('messageDraft');
}

function restoreDraft() {
  chrome.storage.local.get(['messageDraft'], (data) => {
    const draft = data.messageDraft;
    if (!draft) return;
    const hasContent = (draft.items && draft.items.length > 0) || draft.label || draft.text;
    if (!hasContent) return;
    document.getElementById('msgLabel').value = draft.label || '';
    document.getElementById('msgSrNo').value = draft.srNo || '';
    document.getElementById('msgText').value = draft.text || '';
    composingItems = draft.items || [];
    editingMessageId = draft.editingMessageId || null;
    renderComposingItems();
    document.getElementById('saveMessageBtn').textContent = editingMessageId ? 'Update message' : 'Save message';
    document.getElementById('cancelEditMessageBtn').style.display = editingMessageId ? '' : 'none';
  });
}

document.getElementById('attachToggleBtn').addEventListener('click', () => {
  document.getElementById('msgFile').click();
});

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.getElementById('msgFile').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      alert(`"${file.name}" is larger than 15MB — WhatsApp Web may reject it.`);
    }
  }
  const dataUrls = await Promise.all(files.map(readFileAsDataUrl));
  files.forEach((file, i) => {
    composingItems.push({
      kind: 'media',
      media: { dataUrl: dataUrls[i], filename: file.name, mimeType: file.type },
      caption: ''
    });
  });
  document.getElementById('msgFile').value = '';
  renderComposingItems();
  saveDraft();
});

document.getElementById('addTextItemBtn').addEventListener('click', () => {
  const textarea = document.getElementById('msgText');
  const text = textarea.value.trim();
  if (!text) return;
  composingItems.push({ kind: 'text', text });
  textarea.value = '';
  renderComposingItems();
  saveDraft();
});

document.getElementById('msgLabel').addEventListener('input', saveDraft);
document.getElementById('msgText').addEventListener('input', saveDraft);

// Fills in each media item's caption with its own file name (extension
// stripped), but only where the caption is still empty — a quick starting
// point for messages with many attachments, without clobbering captions
// already typed in.
function stripExtension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}
document.getElementById('fillCaptionsBtn').addEventListener('click', () => {
  let filled = 0;
  composingItems.forEach((item) => {
    if (item.kind === 'media' && !item.caption) {
      item.caption = stripExtension(item.media.filename);
      filled++;
    }
  });
  if (filled === 0) {
    alert('No media items with an empty caption to fill.');
    return;
  }
  renderComposingItems();
  saveDraft();
});

document.getElementById('clearAllItemsBtn').addEventListener('click', () => {
  if (composingItems.length === 0) return;
  if (!confirm('Remove all items from this message?')) return;
  composingItems = [];
  renderComposingItems();
  saveDraft();
});

function renderComposingItems() {
  document.getElementById('composingCount').textContent = String(composingItems.length);
  const box = document.getElementById('composingItems');
  if (composingItems.length === 0) {
    box.innerHTML = '<span class="hint">No items yet — write text and tap + or attach a file.</span>';
    return;
  }
  box.innerHTML = composingItems
    .map((item, i) => {
      const icon = item.kind === 'media' ? '📎' : '📝';
      const preview =
        item.kind === 'media'
          ? escapeHtml(item.media.filename)
          : escapeHtml(item.text.slice(0, 80));
      const captionField =
        item.kind === 'media'
          ? `<textarea class="caption-input" data-idx="${i}" placeholder="Caption (optional)" rows="2">${escapeHtml(item.caption || '')}</textarea>`
          : '';
      return `<div class="composing-item">
        <input type="number" class="item-srno-input" data-idx="${i}" min="1" max="${composingItems.length}" value="${i + 1}" title="Thread number — change it to move this item to that position" />
        <span class="composing-item-icon">${icon}</span>
        <div class="composing-item-body">
          <div class="composing-item-preview">${preview}</div>
          ${captionField}
        </div>
        <div class="composing-item-actions">
          <button type="button" data-act="up" data-idx="${i}" title="Move up">▲</button>
          <button type="button" data-act="down" data-idx="${i}" title="Move down">▼</button>
          <button type="button" data-act="remove" data-idx="${i}" title="Remove">✕</button>
        </div>
      </div>`;
    })
    .join('');

  box.querySelectorAll('.caption-input').forEach((input) => {
    input.addEventListener('input', (e) => {
      composingItems[Number(e.target.dataset.idx)].caption = e.target.value;
      saveDraft();
    });
  });
  // Typing a thread number moves that item to that position in the list —
  // items are sent in this same array order, so reordering here directly
  // controls send order, not just display.
  box.querySelectorAll('.item-srno-input').forEach((input) => {
    input.addEventListener('change', (e) => {
      const from = Number(e.target.dataset.idx);
      let to = Number(e.target.value) - 1;
      if (!Number.isFinite(to)) to = from;
      to = Math.max(0, Math.min(composingItems.length - 1, to));
      if (to !== from) {
        const [moved] = composingItems.splice(from, 1);
        composingItems.splice(to, 0, moved);
        saveDraft();
      }
      renderComposingItems();
    });
  });
  box.querySelectorAll('[data-act="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      composingItems.splice(Number(btn.dataset.idx), 1);
      renderComposingItems();
      saveDraft();
    });
  });
  box.querySelectorAll('[data-act="up"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.idx);
      if (i === 0) return;
      [composingItems[i - 1], composingItems[i]] = [composingItems[i], composingItems[i - 1]];
      renderComposingItems();
      saveDraft();
    });
  });
  box.querySelectorAll('[data-act="down"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.idx);
      if (i === composingItems.length - 1) return;
      [composingItems[i], composingItems[i + 1]] = [composingItems[i + 1], composingItems[i]];
      renderComposingItems();
      saveDraft();
    });
  });
}

// Next unused serial number, suggested as the default for a new message so
// it doesn't have to be typed by hand every time — one past whatever's
// already the highest among saved messages.
function nextSrNo() {
  const max = STATE.messages.reduce((m, msg) => (typeof msg.srNo === 'number' ? Math.max(m, msg.srNo) : m), 0);
  return max + 1;
}

function resetMessageForm() {
  editingMessageId = null;
  composingItems = [];
  document.getElementById('msgLabel').value = '';
  document.getElementById('msgSrNo').value = nextSrNo();
  document.getElementById('msgText').value = '';
  document.getElementById('msgFile').value = '';
  renderComposingItems();
  document.getElementById('saveMessageBtn').textContent = 'Save message';
  document.getElementById('cancelEditMessageBtn').style.display = 'none';
  clearDraft();
}

document.getElementById('cancelEditMessageBtn').addEventListener('click', resetMessageForm);

document.getElementById('saveMessageBtn').addEventListener('click', async () => {
  const label = document.getElementById('msgLabel').value.trim();
  if (composingItems.length === 0) {
    alert('Add at least one text or attachment item first.');
    return;
  }
  const first = composingItems[0];
  const name = label || (first.kind === 'media' ? first.media.filename : first.text.slice(0, 30));
  const srNoRaw = document.getElementById('msgSrNo').value;
  const srNo = srNoRaw !== '' ? Number(srNoRaw) : undefined;
  const message = { id: editingMessageId, name, srNo, items: composingItems };
  await call('saveMessage', { message });
  resetMessageForm();
  refresh();
});

// Messages without a serial number sort after ones that have it (by
// creation order among themselves), rather than being scattered in with
// numbered ones at position 0.
function sortMessagesBySrNo(messages) {
  return messages.slice().sort((a, b) => {
    const sa = typeof a.srNo === 'number' ? a.srNo : Infinity;
    const sb = typeof b.srNo === 'number' ? b.srNo : Infinity;
    if (sa !== sb) return sa - sb;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

// Reassigns every saved message's srNo to its position (1..N) in current
// sort order, then swaps the srNo of the message at `id` with its neighbor
// in the given direction. Normalizing first means reorder buttons work
// sensibly even when srNo values were sparse/blank/duplicated, and every
// subsequent move only has to touch the two swapped messages.
async function moveMessage(id, direction) {
  const sorted = sortMessagesBySrNo(STATE.messages);
  const idx = sorted.findIndex((m) => m.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;

  const normalized = sorted.map((m, i) => ({ id: m.id, srNo: i + 1, original: m.srNo }));
  [normalized[idx].srNo, normalized[swapIdx].srNo] = [normalized[swapIdx].srNo, normalized[idx].srNo];

  for (const m of normalized) {
    if (m.original !== m.srNo) {
      await call('saveMessage', { message: { id: m.id, srNo: m.srNo } });
    }
  }
  refresh();
}

function renderMessages() {
  const ul = document.getElementById('messageList');
  ul.innerHTML = '';
  if (STATE.messages.length === 0) {
    ul.innerHTML = '<li class="item-text">No saved messages yet.</li>';
  }
  const sortedMessages = sortMessagesBySrNo(STATE.messages);
  sortedMessages.forEach((m, idx) => {
    const li = document.createElement('li');
    const items = m.items || [];
    const first = items[0];
    const firstPreview = first
      ? first.kind === 'media'
        ? `📎 ${escapeHtml(first.media ? first.media.filename : 'attachment')}`
        : escapeHtml((first.text || '').slice(0, 60))
      : '(empty)';
    const preview = items.length > 1 ? `${firstPreview} <span class="muted">+${items.length - 1} more item(s)</span>` : firstPreview;
    const lastSent = m.lastSentAt ? `Last sent ${new Date(m.lastSentAt).toLocaleString()}` : 'Never sent';
    const srNoBadge = typeof m.srNo === 'number' ? `<span class="muted">#${m.srNo}</span> ` : '';
    li.innerHTML = `<div class="item-row">
      <div class="item-text">
        ${srNoBadge}<b>${escapeHtml(m.name)}</b><br/>${preview}<br/>
        <span class="log-time">${lastSent}</span>
      </div>
      <div class="item-actions">
        <button class="icon-btn small-icon-btn" data-act="moveUp" type="button" title="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn small-icon-btn" data-act="moveDown" type="button" title="Move down" ${idx === sortedMessages.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="icon-btn small-icon-btn" data-act="send" type="button" title="Send now">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
        </button>
        <button class="icon-btn small-icon-btn" data-act="edit" type="button" title="Edit">${EDIT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn danger" data-act="del" type="button" title="Delete">${DELETE_ICON_SVG}</button>
      </div>
    </div>`;

    // Auto-show the panel whenever this message has a tracked run — not
    // just when the user manually toggled it open — so a live send's
    // progress/pause button is visible without having to remember which
    // message you sent and re-click its Send icon to find out.
    if (openSendPanelMessageId === m.id || messageRunIds.has(m.id)) {
      li.appendChild(buildSendPanel(m));
    }

    li.querySelector('[data-act="send"]').addEventListener('click', () => {
      if (!STATE.settings.consentAccepted) {
        alert('Accept the consent checkbox on the Campaigns or Safety tab first — sending is gated behind it, even for a one-off send.');
        return;
      }
      openSendPanelMessageId = openSendPanelMessageId === m.id ? null : m.id;
      renderMessages();
    });
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingMessageId = m.id;
      document.getElementById('msgLabel').value = m.name;
      document.getElementById('msgSrNo').value = typeof m.srNo === 'number' ? m.srNo : '';
      document.getElementById('msgText').value = '';
      composingItems = (m.items || []).map((item) => ({ ...item })); // clone so cancel doesn't mutate the saved copy
      renderComposingItems();
      document.getElementById('saveMessageBtn').textContent = 'Update message';
      document.getElementById('cancelEditMessageBtn').style.display = '';
      saveDraft();
      document.querySelector('[data-tab="messages"]').click();
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await call('deleteMessage', { id: m.id });
      refresh();
    });
    li.querySelector('[data-act="moveUp"]').addEventListener('click', () => moveMessage(m.id, 'up'));
    li.querySelector('[data-act="moveDown"]').addEventListener('click', () => moveMessage(m.id, 'down'));
    ul.appendChild(li);
  });
}

// Lightweight "send this saved message now" picker — reuses saved lists
// (built in the Lists tab) instead of duplicating any list-building UI here.
// Once a send is running, this panel switches to showing its live progress
// (the storage.onChanged listener triggers refresh()/renderMessages() on
// every count update, so no polling is needed here).
function buildSendPanel(message) {
  const panel = document.createElement('div');
  panel.className = 'send-panel';

  const entry = messageRunIds.get(message.id);
  const runId = entry && entry.runId;
  const run = runId ? STATE.activeRuns[runId] : null;
  if (runId && !run) {
    // Right after sendNow() responds, background.js hasn't necessarily
    // written the run's progress record yet — that happens a moment later,
    // inside runCampaign. Give it a few seconds' grace (well over how long
    // that actually takes) before assuming this is instead a long-finished
    // run background.js already pruned, so a fresh mapping doesn't get
    // wiped out before the real data ever arrives.
    if (Date.now() - (entry.assignedAt || 0) < 8000) {
      panel.innerHTML = '<p class="hint">Starting…</p>';
      return panel;
    }
    messageRunIds.delete(message.id);
    saveMessageRunIds();
  }
  if (run) {
    panel.innerHTML = `
      ${renderProgressBlock(run)}
      ${run.done ? '<button class="ghost small-inline" type="button" data-act="closeSend">Close</button>' : '<p class="hint">Sending — this updates live.</p>'}
    `;
    const closeBtn = panel.querySelector('[data-act="closeSend"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        messageRunIds.delete(message.id);
        saveMessageRunIds();
        openSendPanelMessageId = null;
        renderMessages();
      });
    }
    return panel;
  }

  const items = message.items || [];
  panel.innerHTML = `
    <div class="send-panel-top-row">
      ${
        items.length <= 1
          ? ''
          : `
      <label class="checkbox-row send-item-select-all-row">
        <input type="checkbox" class="send-item-select-all" checked />
        Select all
      </label>
      `
      }
      <button class="icon-btn small-icon-btn send-active-chat-btn" type="button" data-act="sendActiveChat" title="Send to currently open chat — sends only to whatever chat is open right now in the WhatsApp Web tab, no list needed.">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
      </button>
    </div>
    ${
      items.length <= 1
        ? ''
        : `
    <div class="composing-list">
      ${items
        .map((item, idx) => {
          const icon = item.kind === 'media' ? '📎' : '📝';
          const preview = item.kind === 'media' ? escapeHtml(item.media.filename) : escapeHtml((item.text || '').slice(0, 60));
          return `<div class="composing-item">
            <input type="checkbox" class="send-item-select" data-idx="${idx}" checked />
            <span class="composing-item-icon">${icon}</span>
            <div class="composing-item-body">
              <div class="composing-item-preview">${preview}</div>
            </div>
            <div class="composing-item-actions">
              ${
                item.kind === 'media'
                  ? `<button class="icon-btn small-icon-btn" type="button" data-act="openItemTab" data-idx="${idx}" title="Open this file in a new tab">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </button>`
                  : ''
              }
              <button class="icon-btn small-icon-btn" type="button" data-act="sendItemActiveChat" data-idx="${idx}" title="Send only this item to the currently open chat">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
              </button>
            </div>
          </div>`;
        })
        .join('')}
    </div>
    `
    }
    ${
      STATE.lists.length === 0
        ? ''
        : `
    <div class="checklist">
      ${STATE.lists
        .map((l) => `<label><input type="checkbox" class="send-list-check" value="${l.id}" /> ${escapeHtml(l.name)} <span class="muted">(${(l.members || []).length})</span></label>`)
        .join('')}
    </div>
    <div class="send-panel-actions">
      <button class="primary" type="button" data-act="confirmSend">Send now</button>
      <button class="ghost small-inline" type="button" data-act="cancelSend">Cancel</button>
      <label class="checkbox-row send-divider-check-row">
        <input type="checkbox" class="send-divider-check" ${sendPanelDividerPref ? 'checked' : ''} />
        Send a "➖" divider after each item
      </label>
    </div>
    <p class="hint">Sends immediately using your Paced delay settings (Safety tab).</p>
    `
    }
  `;
  const cancelBtn = panel.querySelector('[data-act="cancelSend"]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      messageRunIds.delete(message.id);
      saveMessageRunIds();
      openSendPanelMessageId = null;
      renderMessages();
    });
  }
  const dividerCheck = panel.querySelector('.send-divider-check');
  if (dividerCheck) {
    dividerCheck.addEventListener('change', () => {
      sendPanelDividerPref = dividerCheck.checked;
      chrome.storage.local.set({ sendPanelDividerPref });
    });
  }
  const selectAllCheck = panel.querySelector('.send-item-select-all');
  const itemSelectChecks = panel.querySelectorAll('.send-item-select');
  if (selectAllCheck) {
    selectAllCheck.addEventListener('change', () => {
      itemSelectChecks.forEach((cb) => {
        cb.checked = selectAllCheck.checked;
      });
    });
    itemSelectChecks.forEach((cb) => {
      cb.addEventListener('change', () => {
        const checks = Array.from(itemSelectChecks);
        const allChecked = checks.every((c) => c.checked);
        const noneChecked = checks.every((c) => !c.checked);
        selectAllCheck.checked = allChecked;
        selectAllCheck.indeterminate = !allChecked && !noneChecked;
      });
    });
  }
  const confirmBtn = panel.querySelector('[data-act="confirmSend"]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const listIds = Array.from(panel.querySelectorAll('.send-list-check:checked')).map((cb) => cb.value);
      if (listIds.length === 0) {
        alert('Pick at least one list.');
        return;
      }
      const itemChecks = panel.querySelectorAll('.send-item-select');
      let itemIndexes;
      if (itemChecks.length > 0) {
        itemIndexes = Array.from(itemChecks)
          .filter((cb) => cb.checked)
          .map((cb) => Number(cb.dataset.idx));
        if (itemIndexes.length === 0) {
          alert('Select at least one item to send.');
          return;
        }
      }
      const sendDivider = panel.querySelector('.send-divider-check').checked;
      const res = await call('sendNow', { messageId: message.id, listIds, itemIndexes, sendDivider });
      if (res.ok && res.runId) {
        messageRunIds.set(message.id, { runId: res.runId, assignedAt: Date.now() });
        saveMessageRunIds();
      }
      renderMessages();
    });
  }
  panel.querySelector('[data-act="sendActiveChat"]').addEventListener('click', async () => {
    const res = await call('sendNowActiveChat', { messageId: message.id });
    if (res.ok && res.runId) {
      messageRunIds.set(message.id, { runId: res.runId, assignedAt: Date.now() });
      saveMessageRunIds();
    } else if (!res.ok) {
      alert(res.error || 'Could not send to the currently open chat.');
    }
    renderMessages();
  });
  panel.querySelectorAll('[data-act="sendItemActiveChat"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemIndex = Number(btn.dataset.idx);
      const res = await call('sendItemToActiveChat', { messageId: message.id, itemIndex });
      if (res.ok && res.runId) {
        messageRunIds.set(message.id, { runId: res.runId, assignedAt: Date.now() });
        saveMessageRunIds();
      } else if (!res.ok) {
        alert(res.error || 'Could not send that item to the currently open chat.');
      }
      renderMessages();
    });
  });
  panel.querySelectorAll('[data-act="openItemTab"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = (message.items || [])[Number(btn.dataset.idx)];
      if (item && item.media && item.media.dataUrl) {
        chrome.tabs.create({ url: item.media.dataUrl });
      }
    });
  });
  return panel;
}

// ============ LISTS ============
// Scan/add feeds the persistent chatSource (see refresh()); the user
// searches/selects straight out of that, and a list stores its member
// chats inline (waId/name/type) so it's self-contained once saved.

let scanScope = 'groups';
document.querySelectorAll('#scanScopeToggle .kind-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#scanScopeToggle .kind-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    scanScope = btn.dataset.scope;
    document.getElementById('chatsContactFilter').style.display = scanScope === 'chats' ? '' : 'none';
  });
});

document.getElementById('scanChatsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanChatsBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  const payload = { scope: scanScope };
  if (scanScope === 'chats') payload.contactFilter = document.getElementById('chatsContactFilter').value;
  const res = await call('listOpenChats', payload);
  btn.disabled = false;
  btn.textContent = 'Scan';
  if (!res.ok) {
    alert(res.error || 'Could not scan chats.');
    return;
  }
  const chats = res.chats || [];
  for (const c of chats) {
    if (c.waId) chatSource.set(c.waId, c);
  }
  if (chats.length === 0) {
    alert('No chats found — is web.whatsapp.com open and logged in?');
  } else {
    await call('saveFetchedChats', { chats });
  }
  renderListBuilder();
});

document.getElementById('manualAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('manualContactNumber');
  const number = input.value.trim();
  if (!number) return;
  const btn = document.getElementById('manualAddBtn');
  btn.disabled = true;
  const res = await call('findContactByNumber', { number });
  btn.disabled = false;
  if (!res.ok) {
    alert(res.error || 'Could not find that contact.');
    return;
  }
  chatSource.set(res.contact.waId, res.contact);
  selectedWaIds.add(res.contact.waId); // explicitly added, so pre-select it
  await call('saveFetchedChats', { chats: [res.contact] });
  input.value = '';
  renderListBuilder();
});

document.getElementById('clearFetchedBtn').addEventListener('click', async () => {
  if (!confirm('Clear the fetched chats list? Saved lists are not affected.')) return;
  await call('clearFetchedChats');
  chatSource = new Map();
  selectedWaIds = new Set();
  renderListBuilder();
});

document.getElementById('exportFetchedBtn').addEventListener('click', () => {
  const chats = Array.from(chatSource.values());
  if (chats.length === 0) {
    alert('Nothing fetched yet to export.');
    return;
  }
  downloadCsv('whatsapp-fetched-chats.csv', chats);
});

document.getElementById('listSearchInput').addEventListener('input', (e) => {
  listSearchQuery = e.target.value.trim().toLowerCase();
  renderListBuilder();
});

function filteredChatSource() {
  const all = Array.from(chatSource.values());
  const filtered = listSearchQuery
    ? all.filter((c) => c.name.toLowerCase().includes(listSearchQuery) || (c.number && c.number.includes(listSearchQuery)))
    : all;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

document.getElementById('selectAllBtn').addEventListener('click', () => {
  for (const c of filteredChatSource()) selectedWaIds.add(c.waId);
  renderListBuilder();
});
document.getElementById('deselectAllBtn').addEventListener('click', () => {
  for (const c of filteredChatSource()) selectedWaIds.delete(c.waId);
  renderListBuilder();
});

function renderListBuilder() {
  const box = document.getElementById('listBuilderChecklist');
  const visible = filteredChatSource();
  box.innerHTML =
    visible
      .map((c) => {
        const numberSuffix = c.number ? ` <span class="muted">(${escapeHtml(c.number)})</span>` : '';
        const unsavedBadge = c.isSavedContact === false ? ' <span class="badge badge-unsaved">not saved</span>' : '';
        return `<label><input type="checkbox" class="list-builder-check" value="${escapeHtml(c.waId)}" ${selectedWaIds.has(c.waId) ? 'checked' : ''}/> ${escapeHtml(c.name)}${numberSuffix} <span class="badge badge-${c.type}">${c.type}</span>${unsavedBadge}</label>`;
      })
      .join('') || '<span class="hint">Scan or add a contact above first.</span>';
  box.querySelectorAll('.list-builder-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedWaIds.add(cb.value);
      else selectedWaIds.delete(cb.value);
      document.getElementById('selectedCount').textContent = `${selectedWaIds.size} selected`;
    });
  });
  document.getElementById('selectedCount').textContent = `${selectedWaIds.size} selected`;
}

function resetListForm() {
  editingListId = null;
  selectedWaIds = new Set();
  listSearchQuery = '';
  document.getElementById('listName').value = '';
  document.getElementById('listSearchInput').value = '';
  document.getElementById('listBuilderTitle').textContent = 'Build a list';
  document.getElementById('saveListBtn').textContent = 'Save list';
  document.getElementById('cancelEditListBtn').style.display = 'none';
  renderListBuilder();
}
document.getElementById('cancelEditListBtn').addEventListener('click', resetListForm);

document.getElementById('saveListBtn').addEventListener('click', async () => {
  const name = document.getElementById('listName').value.trim();
  if (!name) {
    alert('Give this list a name.');
    return;
  }
  if (selectedWaIds.size === 0) {
    alert('Select at least one group/contact.');
    return;
  }
  const members = Array.from(selectedWaIds).map((waId) => chatSource.get(waId)).filter(Boolean);
  await call('saveList', { list: { id: editingListId, name, members } });
  resetListForm();
  refresh();
});

function renderLists() {
  const ul = document.getElementById('listsList');
  ul.innerHTML = '';
  if (STATE.lists.length === 0) {
    ul.innerHTML = '<li class="item-text">No saved lists yet.</li>';
  }
  for (const l of STATE.lists) {
    const members = l.members || [];
    const names = members.map((m) => m.name);
    const li = document.createElement('li');
    li.innerHTML = `<div class="item-row">
      <div class="item-text">
        <b>${escapeHtml(l.name)}</b> <span class="muted">(${members.length})</span><br/>
        <span class="log-time">${escapeHtml(names.slice(0, 4).join(', '))}${names.length > 4 ? '…' : ''}</span>
      </div>
      <div class="item-actions">
        <button class="icon-btn small-icon-btn" data-act="edit" type="button" title="Edit">${EDIT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn" data-act="export" type="button" title="Export to CSV">${EXPORT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn danger" data-act="del" type="button" title="Delete">${DELETE_ICON_SVG}</button>
      </div>
    </div>`;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingListId = l.id;
      selectedWaIds = new Set(members.map((m) => m.waId));
      for (const m of members) chatSource.set(m.waId, m); // merge so they show without a fresh scan
      listSearchQuery = '';
      document.getElementById('listSearchInput').value = '';
      document.getElementById('listName').value = l.name;
      document.getElementById('listBuilderTitle').textContent = `Editing "${l.name}"`;
      document.getElementById('saveListBtn').textContent = 'Update list';
      document.getElementById('cancelEditListBtn').style.display = '';
      renderListBuilder();
      document.querySelector('[data-tab="lists"]').click();
    });
    li.querySelector('[data-act="export"]').addEventListener('click', () => {
      downloadCsv(`${l.name.replace(/[^a-z0-9]+/gi, '_') || 'list'}.csv`, members);
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete list "${l.name}"? Campaigns using it will have it removed from their targets.`)) return;
      await call('deleteList', { id: l.id });
      refresh();
    });
    ul.appendChild(li);
  }
}

// ============ CAMPAIGNS ============

document.getElementById('consentAcceptBtn').addEventListener('click', async () => {
  if (!document.getElementById('consentCheckbox').checked) {
    alert('Please check the box to confirm before enabling campaigns.');
    return;
  }
  await call('saveSettings', { settings: { consentAccepted: true } });
  refresh();
});

// Staged schedule data for the campaign currently being built/edited —
// same "chips" pattern as composing message items.
let campScheduleType = 'times';
let campTimes = [];
let campDatetimes = [];

function setCampScheduleType(type) {
  campScheduleType = type;
  document.querySelectorAll('#campScheduleTypeToggle .kind-btn').forEach((b) => b.classList.toggle('active', b.dataset.scheduleType === type));
  document.getElementById('campTimesPanel').style.display = type === 'times' ? '' : 'none';
  document.getElementById('campIntervalPanel').style.display = type === 'interval' ? '' : 'none';
  document.getElementById('campOncePanel').style.display = type === 'once' ? '' : 'none';
}

document.querySelectorAll('#campScheduleTypeToggle .kind-btn').forEach((btn) => {
  btn.addEventListener('click', () => setCampScheduleType(btn.dataset.scheduleType));
});

function renderCampTimesList() {
  const box = document.getElementById('campTimesList');
  box.innerHTML = campTimes.length
    ? campTimes.map((t, i) => `<span class="chip">${escapeHtml(t)}<button type="button" data-idx="${i}">✕</button></span>`).join('')
    : '<span class="hint">No times added yet.</span>';
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      campTimes.splice(Number(btn.dataset.idx), 1);
      renderCampTimesList();
    });
  });
}

document.getElementById('addTimeBtn').addEventListener('click', () => {
  const input = document.getElementById('campTimeInput');
  if (!input.value || campTimes.includes(input.value)) return;
  campTimes.push(input.value);
  campTimes.sort();
  renderCampTimesList();
});

function renderCampDatetimesList() {
  const box = document.getElementById('campDatetimesList');
  box.innerHTML = campDatetimes.length
    ? campDatetimes
        .map((dt, i) => `<span class="chip">${escapeHtml(new Date(dt).toLocaleString())}<button type="button" data-idx="${i}">✕</button></span>`)
        .join('')
    : '<span class="hint">No dates added yet.</span>';
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      campDatetimes.splice(Number(btn.dataset.idx), 1);
      renderCampDatetimesList();
    });
  });
}

document.getElementById('addDatetimeBtn').addEventListener('click', () => {
  const input = document.getElementById('campDatetimeInput');
  if (!input.value) return;
  campDatetimes.push(input.value);
  campDatetimes.sort();
  renderCampDatetimesList();
});

function setDelayFieldsDisabled(disabled) {
  ['campDelayMin', 'campDelayMax', 'campListDelayMin', 'campListDelayMax'].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });
}
document.getElementById('campUseDefaultDelay').addEventListener('change', (e) => {
  setDelayFieldsDisabled(e.target.checked);
});
document.getElementById('campSendDivider').addEventListener('change', (e) => {
  campaignDividerPref = e.target.checked;
  chrome.storage.local.set({ campaignDividerPref });
});

function resetCampaignForm() {
  editingCampaignId = null;
  document.getElementById('campName').value = '';
  campTimes = [];
  campDatetimes = [];
  renderCampTimesList();
  renderCampDatetimesList();
  setCampScheduleType('times');
  document.getElementById('campTimeInput').value = '09:00';
  document.getElementById('campDatetimeInput').value = '';
  document.getElementById('campIntervalValue').value = 1;
  document.getElementById('campIntervalUnit').value = 'hours';
  document.getElementById('campTimesPerDay').value = '';
  document.getElementById('campWindowStart').value = '';
  document.getElementById('campWindowEnd').value = '';
  document.getElementById('campUseDefaultDelay').checked = true;
  setDelayFieldsDisabled(true);
  const s = STATE.settings;
  const [dMin, dMax] = s.defaultDelayBetweenMsMs || [20000, 45000];
  const [lMin, lMax] = s.defaultDelayBetweenListsMs || [30000, 60000];
  document.getElementById('campDelayMin').value = Math.round(dMin / 1000);
  document.getElementById('campDelayMax').value = Math.round(dMax / 1000);
  document.getElementById('campListDelayMin').value = Math.round(lMin / 1000);
  document.getElementById('campListDelayMax').value = Math.round(lMax / 1000);
  document.getElementById('campSendDivider').checked = campaignDividerPref;
  document.getElementById('addCampaignBtn').textContent = 'Save campaign';
  document.getElementById('cancelEditCampaignBtn').style.display = 'none';
  renderCampaignForm();
}
document.getElementById('cancelEditCampaignBtn').addEventListener('click', resetCampaignForm);

function renderCampaignForm() {
  const sel = document.getElementById('campMessageSelect');
  // Rebuilding <select>'s options resets the browser's selection to the
  // first one unless explicitly restored — this ran on every refresh()
  // (e.g. any storage change elsewhere), silently discarding whatever the
  // user had picked.
  const desiredMessageId = editingCampaignId
    ? (STATE.campaigns.find((c) => c.id === editingCampaignId) || {}).messageId
    : sel.value;
  sel.innerHTML =
    sortMessagesBySrNo(STATE.messages)
      .map((m) => `<option value="${m.id}">${typeof m.srNo === 'number' ? `#${m.srNo} ` : ''}${escapeHtml(m.name)}</option>`)
      .join('') || '<option value="">No messages saved</option>';
  if (desiredMessageId) sel.value = desiredMessageId;

  const checklist = document.getElementById('campListChecklist');
  const checkedIds = editingCampaignId
    ? new Set((STATE.campaigns.find((c) => c.id === editingCampaignId) || { listIds: [] }).listIds)
    : new Set(Array.from(document.querySelectorAll('.camp-list-check:checked')).map((cb) => cb.value));
  checklist.innerHTML =
    STATE.lists
      .map(
        (l) =>
          `<label><input type="checkbox" class="camp-list-check" value="${l.id}" ${checkedIds.has(l.id) ? 'checked' : ''}/> ${escapeHtml(l.name)} <span class="muted">(${(l.members || []).length})</span></label>`
      )
      .join('') || '<span class="hint">Build a list first.</span>';

  const gate = document.getElementById('consentGate');
  const content = document.getElementById('campaignsContent');
  const accepted = !!STATE.settings.consentAccepted;
  gate.style.display = accepted ? 'none' : '';
  content.style.display = accepted ? '' : 'none';
}

document.getElementById('addCampaignBtn').addEventListener('click', async () => {
  const name = document.getElementById('campName').value.trim();
  const messageId = document.getElementById('campMessageSelect').value;
  const listIds = Array.from(document.querySelectorAll('.camp-list-check:checked')).map((cb) => cb.value);

  if (!name) { alert('Give this campaign a name.'); return; }
  if (!messageId) { alert('Pick a saved message.'); return; }
  if (listIds.length === 0) { alert('Pick at least one list.'); return; }

  const useDefaultDelay = document.getElementById('campUseDefaultDelay').checked;
  const sendDivider = document.getElementById('campSendDivider').checked;
  const campaign = {
    id: editingCampaignId,
    name,
    messageId,
    listIds,
    scheduleType: campScheduleType,
    enabled: true,
    useDefaultDelay,
    sendDivider,
    delayBetweenMsMs: [
      secToMs(document.getElementById('campDelayMin').value, 20000),
      secToMs(document.getElementById('campDelayMax').value, 45000)
    ],
    delayBetweenListsMs: [
      secToMs(document.getElementById('campListDelayMin').value, 30000),
      secToMs(document.getElementById('campListDelayMax').value, 60000)
    ]
  };

  if (campScheduleType === 'times') {
    if (campTimes.length === 0) { alert('Add at least one daily time.'); return; }
    campaign.times = campTimes.slice();
  } else if (campScheduleType === 'interval') {
    const timesPerDay = Number(document.getElementById('campTimesPerDay').value);
    if (timesPerDay > 0) {
      campaign.intervalMinutes = Math.round(1440 / timesPerDay);
    } else {
      const value = Number(document.getElementById('campIntervalValue').value) || 1;
      const unit = document.getElementById('campIntervalUnit').value;
      campaign.intervalMinutes = unit === 'hours' ? value * 60 : value;
    }
    campaign.windowStart = document.getElementById('campWindowStart').value || null;
    campaign.windowEnd = document.getElementById('campWindowEnd').value || null;
  } else if (campScheduleType === 'once') {
    if (campDatetimes.length === 0) { alert('Add at least one date/time.'); return; }
    campaign.datetimes = campDatetimes.slice();
  }

  await call('saveCampaign', { campaign });
  resetCampaignForm();
  refresh();
});

function scheduleSummary(c) {
  if (c.scheduleType === 'times') {
    const times = c.times || [];
    return times.length ? `daily at ${times.join(', ')}` : 'no times set';
  }
  if (c.scheduleType === 'interval') {
    const minutes = c.intervalMinutes || 60;
    const everyText = minutes % 60 === 0 ? `every ${minutes / 60}h` : `every ${minutes}m`;
    const windowText = c.windowStart && c.windowEnd ? ` (${c.windowStart}–${c.windowEnd})` : '';
    return `${everyText}${windowText}`;
  }
  if (c.scheduleType === 'once') {
    const pending = (c.datetimes || []).filter(Boolean);
    return pending.length ? `${pending.length} one-time run(s) pending` : 'no runs pending';
  }
  return 'unscheduled';
}

function renderCampaignList() {
  const ul = document.getElementById('campaignList');
  ul.innerHTML = '';
  if (STATE.campaigns.length === 0) {
    ul.innerHTML = '<li class="item-text">No campaigns yet.</li>';
  }
  for (const c of STATE.campaigns) {
    const msg = STATE.messages.find((m) => m.id === c.messageId);
    const listNames = STATE.lists.filter((l) => c.listIds.includes(l.id)).map((l) => l.name);
    const li = document.createElement('li');
    li.innerHTML = `<div class="item-row">
      <div class="item-text">
        <b>${escapeHtml(c.name)}</b><br/>
        ${msg ? escapeHtml(msg.name) : '(deleted message)'} → ${escapeHtml(listNames.join(', ') || '(no lists)')}<br/>
        <span class="log-time">${escapeHtml(scheduleSummary(c))} · ${c.enabled ? 'enabled' : 'paused'}</span>
      </div>
      <div class="item-actions">
        <button class="icon-btn small-icon-btn" data-act="edit" type="button" title="Edit">${EDIT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn" data-act="toggle" type="button" title="${c.enabled ? 'Pause' : 'Resume'}">${c.enabled ? PAUSE_ICON_SVG : PLAY_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn" data-act="run" type="button" title="Run now">${RUN_NOW_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn danger" data-act="del" type="button" title="Delete">${DELETE_ICON_SVG}</button>
      </div>
    </div>
    ${STATE.activeRuns[c.id] ? renderProgressBlock(STATE.activeRuns[c.id]) : ''}`;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingCampaignId = c.id;
      document.getElementById('campName').value = c.name;
      setCampScheduleType(c.scheduleType || 'times');
      campTimes = (c.times || []).slice();
      campDatetimes = (c.datetimes || []).filter(Boolean).slice();
      renderCampTimesList();
      renderCampDatetimesList();
      document.getElementById('campTimeInput').value = '09:00';
      document.getElementById('campDatetimeInput').value = '';
      if (c.scheduleType === 'interval') {
        const minutes = c.intervalMinutes || 60;
        if (minutes % 60 === 0) {
          document.getElementById('campIntervalValue').value = minutes / 60;
          document.getElementById('campIntervalUnit').value = 'hours';
        } else {
          document.getElementById('campIntervalValue').value = minutes;
          document.getElementById('campIntervalUnit').value = 'minutes';
        }
        document.getElementById('campTimesPerDay').value = '';
        document.getElementById('campWindowStart').value = c.windowStart || '';
        document.getElementById('campWindowEnd').value = c.windowEnd || '';
      }
      const useDefaultDelay = c.useDefaultDelay !== false;
      document.getElementById('campUseDefaultDelay').checked = useDefaultDelay;
      setDelayFieldsDisabled(useDefaultDelay);
      document.getElementById('campSendDivider').checked = c.sendDivider !== false;
      const [dMin, dMax] = c.delayBetweenMsMs || [20000, 45000];
      const [lMin, lMax] = c.delayBetweenListsMs || [30000, 60000];
      document.getElementById('campDelayMin').value = Math.round(dMin / 1000);
      document.getElementById('campDelayMax').value = Math.round(dMax / 1000);
      document.getElementById('campListDelayMin').value = Math.round(lMin / 1000);
      document.getElementById('campListDelayMax').value = Math.round(lMax / 1000);
      document.getElementById('addCampaignBtn').textContent = 'Update campaign';
      document.getElementById('cancelEditCampaignBtn').style.display = '';
      renderCampaignForm();
      document.querySelector('[data-tab="campaigns"]').click();
    });
    li.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      await call('toggleCampaign', { id: c.id, enabled: !c.enabled });
      refresh();
    });
    li.querySelector('[data-act="run"]').addEventListener('click', async () => {
      await call('runCampaignNow', { id: c.id });
      setTimeout(refresh, 1500);
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete campaign "${c.name}"?`)) return;
      await call('deleteCampaign', { id: c.id });
      refresh();
    });
    ul.appendChild(li);
  }
}

// ============ LOG ============
document.getElementById('clearLogBtn').addEventListener('click', async () => {
  if (!confirm('Clear the entire activity log?')) return;
  await call('clearLog');
  refresh();
});

// Search text and the status filter persist across popup opens (own
// storage keys, same pattern as lastTab) — kept in these JS vars as the
// source of truth so renderLog() never has to touch the input's live value
// itself (which would fight with the user mid-keystroke on every
// storage-driven refresh() elsewhere in the popup).
let logSearchQuery = '';
let logStatusFilter = 'all';

function updateLogSearchClearBtn() {
  document.getElementById('logSearchClearBtn').classList.toggle('visible', logSearchQuery.length > 0);
}

chrome.storage.local.get(['logSearchQuery', 'logStatusFilter'], (data) => {
  if (data.logSearchQuery) {
    logSearchQuery = data.logSearchQuery;
    document.getElementById('logSearchInput').value = logSearchQuery;
  }
  if (data.logStatusFilter) {
    logStatusFilter = data.logStatusFilter;
    document.getElementById('logStatusFilter').value = logStatusFilter;
  }
  updateLogSearchClearBtn();
  refresh();
});
document.getElementById('logSearchInput').addEventListener('input', (e) => {
  logSearchQuery = e.target.value;
  chrome.storage.local.set({ logSearchQuery });
  updateLogSearchClearBtn();
  renderLog();
});
document.getElementById('logSearchClearBtn').addEventListener('click', () => {
  logSearchQuery = '';
  document.getElementById('logSearchInput').value = '';
  chrome.storage.local.set({ logSearchQuery });
  updateLogSearchClearBtn();
  renderLog();
});
document.getElementById('logStatusFilter').addEventListener('change', (e) => {
  logStatusFilter = e.target.value;
  chrome.storage.local.set({ logStatusFilter });
  renderLog();
});

function renderLog() {
  const ul = document.getElementById('logList');
  const query = logSearchQuery.trim().toLowerCase();
  const filtered = STATE.log.filter((l) => {
    if (logStatusFilter !== 'all' && l.status !== logStatusFilter) return false;
    if (query) {
      // Includes the same formatted date/time string shown under each entry,
      // so a search for e.g. "8/27", "1:13", or "pm" matches by when it ran,
      // not just campaign/chat/message text.
      const haystack = `${l.campaignName || ''} ${l.chatName || ''} ${l.detail || ''} ${new Date(l.timestamp).toLocaleString()}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  ul.innerHTML = '';
  if (filtered.length === 0) {
    ul.innerHTML = `<li class="item-text">${STATE.log.length === 0 ? 'No activity yet.' : 'No log entries match this search/filter.'}</li>`;
  }
  for (const l of filtered) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="item-text">
      <span class="log-status-${l.status}">${l.status.toUpperCase()}</span>
      ${l.campaignName ? ' · ' + escapeHtml(l.campaignName) : ''}
      ${l.chatName ? ' → ' + escapeHtml(l.chatName) : ''}<br/>
      <span class="log-time">${new Date(l.timestamp).toLocaleString()}</span><br/>
      ${escapeHtml(l.detail || '')}
    </div>`;
    ul.appendChild(li);
  }
}

// ============ SETTINGS ============
function renderSettings() {
  const s = STATE.settings;
  document.getElementById('jitterMinutes').value = s.jitterMinutes ?? 4;
  const [min, max] = s.defaultDelayBetweenMsMs || [20000, 45000];
  document.getElementById('delayMin').value = Math.round(min / 1000);
  document.getElementById('delayMax').value = Math.round(max / 1000);
  const [lmin, lmax] = s.defaultDelayBetweenListsMs || [30000, 60000];
  document.getElementById('listDelayMin').value = Math.round(lmin / 1000);
  document.getElementById('listDelayMax').value = Math.round(lmax / 1000);
  document.getElementById('themeSelect').value = s.theme || 'system';
  document.getElementById('consentCheckboxSettings').checked = !!s.consentAccepted;
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const jitterMinutes = Number(document.getElementById('jitterMinutes').value) || 0;
  const min = secToMs(document.getElementById('delayMin').value, 20000);
  const max = secToMs(document.getElementById('delayMax').value, 45000);
  const lmin = secToMs(document.getElementById('listDelayMin').value, 30000);
  const lmax = secToMs(document.getElementById('listDelayMax').value, 60000);
  const theme = document.getElementById('themeSelect').value;
  const consentAccepted = document.getElementById('consentCheckboxSettings').checked;
  await call('saveSettings', {
    settings: {
      jitterMinutes,
      defaultDelayBetweenMsMs: [min, Math.max(min, max)],
      defaultDelayBetweenListsMs: [lmin, Math.max(lmin, lmax)],
      theme,
      consentAccepted
    }
  });
  refresh();
});

// background.js writes log entries (and other state) directly to
// chrome.storage while a campaign runs, with the popup possibly still open
// on the Log tab — without this, nothing tells the popup that happened and
// it looks frozen until closed and reopened. Draft-only writes are excluded
// since those happen on every keystroke while composing a message and are
// already reflected live in the form — a full refresh() on each one would
// make typing feel laggy for no benefit.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.length === 1 && keys[0] === 'messageDraft') return;
  refresh();
});

restoreDraft();
refresh();
