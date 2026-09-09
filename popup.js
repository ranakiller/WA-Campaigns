function call(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (res) => resolve(res || { ok: false, error: 'No response' }));
  });
}

// ============ TOAST NOTIFICATIONS ============
// Replaces every alert() in this file — non-blocking, auto-dismissing,
// bottom-anchored, themed (see .toast-container/.toast in popup.css).
// type: 'error' | 'success' | 'warning' | 'info'. Native confirm() dialogs
// are replaced too, but by a themed modal (showConfirmDialog, below) rather
// than a toast — a toast can't ask a yes/no question, that's a different
// UX pattern (gating a destructive action before it happens).
const TOAST_ICONS = {
  error:
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59Z"/></svg>',
  success:
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9Z"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 7h2v2h-2V7Zm0 4h2v6h-2v-6Zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z"/></svg>'
};
const TOAST_DURATIONS = { error: 6000, warning: 5000, success: 3500, info: 4000 };

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span class="toast-message"></span>
    <button type="button" class="toast-close" aria-label="Dismiss">✕</button>
  `;
  toast.querySelector('.toast-message').textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  let dismissTimer = null;
  function dismiss() {
    clearTimeout(dismissTimer);
    toast.classList.remove('show');
    toast.classList.add('hide');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  dismissTimer = setTimeout(dismiss, TOAST_DURATIONS[type] || TOAST_DURATIONS.info);
}

// ============ CONFIRM DIALOG ============
// Replaces every confirm() in this file — a themed modal instead of the OS
// dialog, resolving to a boolean the same way confirm() did (just async).
// `danger: true` makes the confirm button solid red (destructive actions);
// otherwise it's the normal green primary.
function showConfirmDialog(message, options = {}) {
  const { confirmText = 'OK', cancelText = 'Cancel', danger = false } = options;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <p class="confirm-message"></p>
        <div class="confirm-actions">
          <button type="button" class="ghost confirm-cancel">${CLOSE_ICON_SVG}<span class="btn-label">${escapeHtml(cancelText)}</span></button>
          <button type="button" class="primary${danger ? ' danger' : ''} confirm-ok">${danger ? DELETE_ICON_SVG : CHECK_ICON_SVG}<span class="btn-label">${escapeHtml(confirmText)}</span></button>
        </div>
      </div>
    `;
    overlay.querySelector('.confirm-message').textContent = message;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    // Whatever button opened this (e.g. "Clear log") still has real DOM
    // focus underneath the overlay — without moving focus onto the dialog
    // itself, pressing Enter both resolves this promise (via the keydown
    // listener below) AND re-activates that still-focused button natively,
    // firing its click handler again and opening a second confirm on top
    // of the first, which repeats every time Enter is pressed again.
    const okBtn = overlay.querySelector('.confirm-ok');
    okBtn.focus();

    let resolved = false;
    function close(result) {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('keydown', onKeydown);
      overlay.classList.remove('show');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    }
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKeydown);
  });
}

// One-way notifications background.js sends unprompted (not a response to
// a call() request) — currently just a background sync push failure,
// surfaced live if the popup happens to be open when it happens.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'toast') {
    showToast(msg.message, msg.type || 'info');
  }
});

let STATE = { fetchedChats: [], lists: [], messages: [], log: [], settings: {}, activeRuns: {} };
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
// The currently-running "delete for everyone" run, if any — only one at a
// time. Persisted the same way as messageRunIds so it survives a popup
// close/reopen mid-run; assignedAt gives the same short grace window as
// messageRunIds before background.js has necessarily written the run's
// storage record yet.
let deleteRunEntry = null; // { runId, assignedAt } | null
function setDeleteRunId(id) {
  deleteRunEntry = id ? { runId: id, assignedAt: Date.now() } : null;
  chrome.storage.local.set({ deleteRunEntry });
}
chrome.storage.local.get(['deleteRunEntry'], (data) => {
  if (data.deleteRunEntry && data.deleteRunEntry.runId) deleteRunEntry = data.deleteRunEntry;
});
// Same pattern again for the "send without saving" panel on the Messages
// tab compose form — only one draft/compose form exists, so only one such
// run can ever be in flight at a time. Its target-list selections live in
// the same listSelections map as everything else, keyed by this constant
// instead of a real message id (real ids are UUIDs, so this can never
// collide with one).
const ADHOC_DRAFT_KEY = '__adhoc_draft__';
let adhocSendPanelOpen = false;
let adhocRunEntry = null; // { runId, assignedAt } | null
function setAdhocRunId(id) {
  adhocRunEntry = id ? { runId: id, assignedAt: Date.now() } : null;
  chrome.storage.local.set({ adhocRunEntry });
}
chrome.storage.local.get(['adhocRunEntry'], (data) => {
  if (data.adhocRunEntry && data.adhocRunEntry.runId) adhocRunEntry = data.adhocRunEntry;
});
// Which items are unchecked in a message's send panel — kept in memory (not
// persisted) so the checkboxes survive the re-render that follows every
// send/click instead of snapping back to "all checked", which looked like
// the selection had been silently discarded even though the send itself
// correctly used whatever was checked at click time.
const itemSelectionUnchecked = new Map(); // messageId -> Set<itemIndex>
function uncheckedSetFor(messageId) {
  let set = itemSelectionUnchecked.get(messageId);
  if (!set) {
    set = new Set();
    itemSelectionUnchecked.set(messageId, set);
  }
  return set;
}
// Same idea, one level down, but flipped: which chats within a list are
// *selected* for this particular send — every list/chat starts unchecked by
// default (nothing is picked until you explicitly pick it), so this tracks
// selections rather than exclusions. Checking a list's own checkbox selects
// all its members; checking individual chats without touching the list
// checkbox selects just those. Persisted to chrome.storage.local (unlike
// itemSelectionUnchecked above) so it survives closing and reopening the
// popup, not just surviving a re-render within one session.
const listSelections = new Map(); // messageId -> Map(listId -> Set<waId>)
function listSelectionSetFor(messageId, listId) {
  let byList = listSelections.get(messageId);
  if (!byList) {
    byList = new Map();
    listSelections.set(messageId, byList);
  }
  let set = byList.get(listId);
  if (!set) {
    set = new Set();
    byList.set(listId, set);
  }
  return set;
}
function saveListSelections() {
  const plain = {};
  for (const [msgId, byList] of listSelections) {
    plain[msgId] = {};
    for (const [listId, set] of byList) {
      plain[msgId][listId] = Array.from(set);
    }
  }
  chrome.storage.local.set({ listSelections: plain });
}
chrome.storage.local.get(['listSelections'], (data) => {
  const plain = data.listSelections || {};
  for (const msgId of Object.keys(plain)) {
    const byList = new Map();
    for (const listId of Object.keys(plain[msgId])) {
      byList.set(listId, new Set(plain[msgId][listId]));
    }
    listSelections.set(msgId, byList);
  }
  refresh();
});
// Which lists currently have their member checklist expanded — purely a
// this-session UI convenience, doesn't need to survive a popup reopen.
const expandedListPanels = new Set(); // `${messageId}:${listId}`
// Same idea: a multi-item message's "What to send" checklist defaults to
// collapsed (a one-line "All N items selected" summary) since most sends
// want everything — only messageIds in this set show the full per-item
// checklist. Keeps the panel's first screenful about actually sending, not
// item bookkeeping most people never touch.
const expandedItemPickers = new Set(); // messageId
// Same for the schedule editor's rarely-changed delay-override/label
// fields — collapsed behind "Advanced" until opened.
let scheduleAdvancedOpen = false;
// Same idea as messageRunIds, but for the "send to current chat"/"send this
// item to current chat" buttons — these are quick one-off sends, not a list
// run, so instead of taking over the whole panel with a progress block they
// turn their own button into a small round percentage indicator. Keyed by
// message id (whole-message send) or `${messageId}:${itemIndex}` (one item).
const activeChatRunIds = new Map();
function saveActiveChatRunIds() {
  chrome.storage.local.set({ activeChatRunIds: Object.fromEntries(activeChatRunIds) });
}
chrome.storage.local.get(['activeChatRunIds'], (data) => {
  for (const [key, entry] of Object.entries(data.activeChatRunIds || {})) {
    if (entry && entry.runId) activeChatRunIds.set(key, entry);
  }
});
// Looks up the live run for one of those keys, clearing it out (and
// persisting the clear) once it's done or once it's been too long to
// plausibly still be "about to start" — so the button reverts to normal
// without any lingering finished-state UI to dismiss.
function activeChatRunFor(key) {
  const entry = activeChatRunIds.get(key);
  if (!entry) return null;
  const run = STATE.activeRuns[entry.runId];
  if (!run) {
    if (Date.now() - (entry.assignedAt || 0) < 8000) return { starting: true, id: entry.runId };
    activeChatRunIds.delete(key);
    saveActiveChatRunIds();
    return null;
  }
  if (run.done) {
    activeChatRunIds.delete(key);
    saveActiveChatRunIds();
    return null;
  }
  return run;
}
function activeChatRunPct(run) {
  if (!run || run.starting) return 0;
  const done = (run.sent || 0) + (run.failed || 0);
  return run.total ? Math.round((done / run.total) * 100) : 0;
}
// The message currently being composed/edited — an ordered sequence of
// items, each independently text or media(+its own caption). Sent one after
// another to each chat before the campaign moves on to the next chat.
let composingItems = []; // { kind: 'text', text } | { kind: 'media', media, caption }
// The exact composingItems object (by reference, not index — indexes shift
// under reordering/removal, object identity doesn't) currently pulled into
// the text box for editing via a thread's pencil icon, or null if the box
// is just for composing something new. "+"/Ctrl+Enter updates this item in
// place instead of adding a new one while it's set.
let editingThreadItem = null;
let editingMessageId = null;
// The srNo (saved-messages list position) of whichever message is being
// edited, so saving the edit keeps it in the same spot instead of
// reassigning a new one — there's no input field for this any more (the
// ▲/▼ buttons on each saved message row handle reordering directly).
let editingMessageSrNo = null;
let editingListId = null;

// Header/footer for the message currently being composed — 'default' (use
// the global Settings-tab text), 'custom' (this message's own text below),
// or 'off' (never add one here, even if the global settings have one).
// Saved onto the message alongside its items; also honored by an unsaved
// "Send Now" so the override doesn't require saving to take effect. A
// single item/thread can further override this via its own
// headerFooterMode/headerText/footerText (see composing-item HF panel) —
// resolution order is item -> message -> global, done in background.js.
let composingHfMode = 'default';
let composingHfHeaderText = '';
let composingHfFooterText = '';
let messageHfPanelOpen = false;

// Auto-reply: send this message's own content back into whichever chat
// asked for it, the moment an incoming message matches one of its triggers
// (see background.js's handleIncomingMessage). Lives on the message the
// same way headerFooterMode does — set here while composing/editing,
// carried on message.autoReply once saved.
function defaultAutoReply() {
  return { enabled: false, triggers: [], cooldownEnabled: true, cooldownValue: 60, cooldownUnit: 'minutes' };
}
let composingAutoReply = defaultAutoReply();
let messageAutoReplyPanelOpen = false;
// Which single composing item (by reference) currently has its own HF
// panel expanded, or null. Only one open at a time, same pattern as
// editingThreadItem.
let hfPanelItem = null;
// Bulk "apply this header/footer to every thread/attachment" tool, opened
// from the toolbar above the list — separate staging state (not tied to
// any one item) so picking a mode/typing text doesn't touch anything until
// "Apply to all" is actually clicked.
let bulkHfPanelOpen = false;
let bulkHfMode = 'default';
let bulkHfHeaderText = '';
let bulkHfFooterText = '';

// The separator checkbox appears in two independent places (the one-off Send
// panel, and the per-message schedule editor) — each remembers its own
// last-used state across popup opens, not tied to any one message/schedule.
// Loaded once here (async), with a re-render once it resolves so anything
// already painted with the checkbox's hardcoded default picks up the real
// value.
let sendPanelSeparatorPref = true;
let scheduleSeparatorPref = true;
chrome.storage.local.get(['sendPanelSeparatorPref', 'scheduleSeparatorPref'], (data) => {
  if (data.sendPanelSeparatorPref !== undefined) sendPanelSeparatorPref = data.sendPanelSeparatorPref;
  if (data.scheduleSeparatorPref !== undefined) scheduleSeparatorPref = data.scheduleSeparatorPref;
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
const MOVE_UP_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 5.5 5 13h4v6h6v-6h4L12 5.5Z"/></svg>';
const MOVE_DOWN_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 18.5 19 11h-4V5H9v6H5l7 7.5Z"/></svg>';
// Icons for the primary/ghost CTA buttons (Send Now, Save, Cancel, etc —
// see popup.css's neumorphic button.primary/.ghost). SEND_ICON_SVG carries
// its own class so button.primary:hover .send-icon can give it the little
// paper-airplane fly-off instead of the generic pop every other button icon
// gets on hover.
const SEND_ICON_SVG =
  '<svg class="send-icon" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
const CHECK_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
const CLOSE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg>';
const SCAN_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 5L20.5 19l-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>';
const KEY_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>';
const REMOVE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z"/></svg>';
const MEDIA_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16.5 6.5v9a4 4 0 0 1-8 0v-9a2.5 2.5 0 0 1 5 0v8a1 1 0 0 1-2 0v-8H10v8a2.5 2.5 0 0 0 5 0v-9a4 4 0 0 0-8 0v9.5a5.5 5.5 0 0 0 11 0V6.5Z"/></svg>';
const TEXT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 5v2h16V5H4Zm0 8h16v-2H4v2Zm0 6h10v-2H4v2Z"/></svg>';
// Header/footer glyph — top and bottom bars solid, the body bar between them
// dimmed, so it reads as "a header and a footer around content" at a glance.
const HF_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" opacity="0.35" d="M4 10.5h16v3H4z"/><path fill="currentColor" d="M4 4h16v3H4V4Zm0 13h16v3H4v-3Z"/></svg>';
const REFRESH_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

function renderProgressBlock(run) {
  const doneCount = run.sent + run.failed;
  const pct = run.total > 0 ? Math.round((doneCount / run.total) * 100) : 0;
  const fillClass = run.failed > 0 ? 'progress-fill has-failures' : 'progress-fill';
  // Same run shape (sent/failed counters) is reused for both a send and a
  // "delete for everyone" run — the wording should match which one it is.
  const verb = String(run.id || '').startsWith('delete-') ? 'deleted' : 'sent';
  const status = run.done
    ? `<span class="progress-label done">Finished — ${run.sent} ${verb}${run.failed ? `, ${run.failed} failed` : ''}</span>`
    : `<span class="progress-label">${run.paused ? 'Paused — ' : ''}${doneCount}/${run.total} (${pct}%) — ${run.sent} ${verb}${run.failed ? `, ${run.failed} failed` : ''}, ${run.total - doneCount} pending</span>`;
  // Pause/resume and reset are wired via a delegated document-level click
  // listener (see below) rather than per-render, since this HTML is
  // inserted via innerHTML from two different places (message send panel,
  // campaign row).
  const controls = !run.done
    ? `<button class="icon-btn small-icon-btn progress-pause-btn" type="button" data-run-id="${run.id}" data-tooltip="${run.paused ? 'Resume' : 'Pause'}">${run.paused ? PLAY_ICON_SVG : PAUSE_ICON_SVG}</button>
       <button class="icon-btn small-icon-btn danger progress-reset-btn" type="button" data-run-id="${run.id}" data-tooltip="Reset (stop and clear this run — doesn't re-send to chats already reached)">${RESET_ICON_SVG}</button>`
    : '';
  return `<div class="progress-block">
    <div class="progress-bar-row">
      <div class="progress-bar"><div class="${fillClass}" style="width:${pct}%"></div></div>
      ${controls}
    </div>
    ${status}
  </div>`;
}

// A "send to current chat" style icon button, in its normal or its sending
// state — sending replaces the arrow icon with a round percentage ring
// (button itself becomes the progress indicator) instead of a separate
// progress bar taking over the panel, since these are one-off sends. The
// ring stays clickable while sending — clicking it stops that run (there's
// no other pause/stop control visible for it once the progress bar is gone).
function activeChatBtnHtml({ act, idx, extraClass = '', title, iconSvg, run, runKey }) {
  const idxAttr = idx === undefined ? '' : ` data-idx="${idx}"`;
  if (!run) {
    return `<button class="icon-btn small-icon-btn ${extraClass}" type="button" data-act="${act}"${idxAttr} data-tooltip="${escapeHtml(title)}">${iconSvg}</button>`;
  }
  const pct = activeChatRunPct(run);
  return `<button class="icon-btn small-icon-btn sending-ring ${extraClass}" type="button" data-act="stopActiveChatSend" data-run-id="${run.id}" data-run-key="${runKey}" style="--pct:${pct}" data-tooltip="Sending… ${pct}% — click to stop">
    <span class="sending-ring-pct">${run.starting ? '' : pct + '%'}</span>
  </button>`;
}

document.addEventListener('click', async (e) => {
  const stopBtn = e.target.closest('[data-act="stopActiveChatSend"]');
  if (stopBtn) {
    if (await showConfirmDialog('Stop this send?', { confirmText: 'Stop', danger: true })) {
      await call('resetRun', { runId: stopBtn.dataset.runId });
      activeChatRunIds.delete(stopBtn.dataset.runKey);
      saveActiveChatRunIds();
      refresh();
    }
    return;
  }
  const pauseBtn = e.target.closest('.progress-pause-btn');
  if (pauseBtn) {
    await call('togglePauseRun', { runId: pauseBtn.dataset.runId });
    return;
  }
  const resetBtn = e.target.closest('.progress-reset-btn');
  if (resetBtn) {
    const ok = await showConfirmDialog("Reset this run? It stops sending the rest — chats already reached won't be re-sent to.", {
      confirmText: 'Reset',
      danger: true
    });
    if (!ok) return;
    await call('resetRun', { runId: resetBtn.dataset.runId });
  }
});

function escapeCsv(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function triggerCsvDownload(filename, header, rows) {
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

async function downloadCsv(filename, chats) {
  // Admin status is checked fresh for whichever groups are actually being
  // exported (not the whole fetched pool) — one WPP call per group, so this
  // is the slow part of an export for a large list. getGroupAdminInfo
  // itself keeps a broken group's failure isolated to that one group/column
  // rather than failing here.
  const groupWaIds = (chats || []).filter((c) => c.type === 'group').map((c) => c.waId);
  let adminInfo = {};
  if (groupWaIds.length > 0) {
    const res = await call('getGroupAdminInfo', { waIds: groupWaIds });
    if (res.ok) adminInfo = res.info || {};
  }
  const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');
  const header = ['Name', 'Type', 'ID / Number', "You're Admin", 'Admin-Only Group'];
  const rows = (chats || []).map((c) => {
    const info = c.type === 'group' ? adminInfo[c.waId] : null;
    return [
      c.name,
      c.type,
      c.type === 'contact' ? c.number || c.waId : c.waId,
      info ? yesNo(info.isAdmin) : '',
      info ? yesNo(info.announceOnly) : ''
    ];
  });
  triggerCsvDownload(filename, header, rows);
}

// Group & Contact Extractor — exports a single group's actual WhatsApp
// membership (who's in it right now), not a saved list.
//
// Many members show up as a "@lid" (Linked ID) instead of their real
// number these days — WhatsApp's own privacy masking. The WhatsApp ID
// column keeps whatever id that member actually has (lid or real number)
// since that's what a send still needs to address them, unchanged from
// before. Phone Number is the extra part: background.js resolves it
// server-side per lid via WPP.contact.getPnLidEntry, which only works
// from what this WhatsApp account already knows locally (no live network
// lookup for this direction) — a lid-masked member with no shared
// history can legitimately come back with no resolvable number, which
// shows as blank here, not an error.
//
// Names: a live-resolved name from that same lookup wins when there is
// one (more likely accurate than a stale local guess); chatSource
// (whatever's already been scanned/added) is the fallback.
//
// Shared between the single-group export below and the bulk one right
// after it — groupName is only appended as its own trailing column for
// the bulk export, so one CSV can hold several groups' members without
// losing which group each row actually came from.
function groupMemberRow(m, groupName) {
  const known = chatSource.get(m.waId);
  const name = m.name || (known ? known.name : '');
  const row = [name, m.number || m.waId, m.phoneNumber || '', m.isAdmin ? 'Yes' : 'No', m.isSuperAdmin ? 'Yes' : 'No'];
  if (groupName !== undefined) row.push(groupName);
  return row;
}

async function downloadGroupMembersCsv(groupName, waId) {
  const res = await call('getGroupMembers', { waId });
  if (!res.ok) {
    showToast(res.error || 'Could not fetch this group’s members.', 'error');
    return;
  }
  const header = ['Name', 'WhatsApp ID (used for sending)', 'Phone Number', 'Is Admin', 'Is Super Admin'];
  const rows = (res.members || []).map((m) => groupMemberRow(m));
  triggerCsvDownload(`${groupName.replace(/[^a-z0-9]+/gi, '_') || 'group'}_members.csv`, header, rows);
}

// Bulk version — every currently-checked GROUP (contacts are skipped,
// they have no members) gets fetched one at a time and merged into a
// single CSV, each row carrying which group it came from so a member in
// more than one selected group shows up once per group rather than being
// silently deduped into one ambiguous row.
async function downloadBulkGroupMembersCsv(groups, onProgress) {
  const header = ['Name', 'WhatsApp ID (used for sending)', 'Phone Number', 'Is Admin', 'Is Super Admin', 'Extracted From Group'];
  const rows = [];
  let done = 0;
  for (const g of groups) {
    const res = await call('getGroupMembers', { waId: g.waId });
    done++;
    if (onProgress) onProgress(done, groups.length);
    if (!res.ok) {
      showToast(`Could not fetch members for "${g.name}": ${res.error || 'unknown error'}`, 'error');
      continue; // one broken group shouldn't stop the rest of the export
    }
    for (const m of res.members || []) rows.push(groupMemberRow(m, g.name));
  }
  if (rows.length === 0) {
    showToast('No members found across the selected groups.', 'error');
    return;
  }
  triggerCsvDownload('group_contacts_bulk_export.csv', header, rows);
}

async function refresh() {
  const res = await call('getState');
  if (res.ok) STATE = res.state;
  applyTheme();
  // license.activated is always true in dev mode (LICENSE_SERVER empty in
  // license.js); with a server configured it's whether a valid key is
  // cached on this install.
  const activated = !STATE.license || !!STATE.license.activated;
  document.getElementById('activationScreen').style.display = activated ? 'none' : 'flex';
  document.getElementById('appContent').style.display = activated ? '' : 'none';
  if (!activated) return;
  for (const c of STATE.fetchedChats || []) {
    chatSource.set(c.waId, c);
  }
  renderMasterToggle();
  renderPrivacyBlurToggle();
  renderPrivacyShortcut();
  renderMessages();
  renderCampaignsTab();
  renderAutoReplyTab();
  renderAdhocSendPanel();
  renderListBuilder();
  renderLists();
  renderLog();
  renderSettings();
  renderKeysTabVisibility();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Primary/ghost buttons now carry an icon alongside their label (see
// popup.css's neumorphic button.primary/.ghost) — the label lives in its
// own <span class="btn-label"> specifically so code that swaps a button's
// text (Save -> Saved, Scan -> Scanning..., etc) can update just that span
// instead of the button's whole textContent, which would silently delete
// the icon too. Falls back to plain textContent for any button that
// doesn't have a label span (icon-only ones, e.g. the nav).
function setBtnLabel(btnOrId, text) {
  const btn = typeof btnOrId === 'string' ? document.getElementById(btnOrId) : btnOrId;
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

function secToMs(sec, fallback) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallback;
}

// ---------- theme ----------
// A permanently-visible segmented pill (System/Light/Dark) in the header —
// no open/close state to manage, unlike the dropdown this replaced, so
// this just keeps the sliding thumb and each button's active/color state
// in sync with STATE.settings.theme.
const THEME_SEG_ORDER = ['system', 'light', 'dark'];
function applyTheme() {
  const theme = STATE.settings.theme || 'system';
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  document.querySelectorAll('.theme-seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  const idx = THEME_SEG_ORDER.indexOf(theme);
  document.getElementById('themeSegmentThumb').style.transform = `translateX(${Math.max(0, idx) * 26}px)`;
}

document.querySelectorAll('.theme-seg-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await call('saveSettings', { settings: { theme: btn.dataset.theme } });
    refresh();
  });
});

// ---------- master on/off switch ----------
// Instant kill switch: off blocks any new send from starting and stops a
// run already in progress (background.js checks this before every single
// item, not just at the start of a campaign).
function renderMasterToggle() {
  const enabled = STATE.settings.masterEnabled !== false;
  document.getElementById('masterToggleBtn').classList.toggle('off', !enabled);
  document.getElementById('masterToggleBtn').dataset.tooltip = enabled ? 'Turn the extension off' : 'Turn the extension on';
  document.getElementById('masterOffBanner').style.display = enabled ? 'none' : '';
}

document.getElementById('masterToggleBtn').addEventListener('click', async () => {
  const enabled = STATE.settings.masterEnabled !== false;
  if (enabled) {
    const ok = await showConfirmDialog('Turn the extension off? This immediately stops any scheduled or one-off send in progress.', {
      confirmText: 'Turn off'
    });
    if (!ok) return;
  }
  await call('saveSettings', { settings: { masterEnabled: !enabled } });
  refresh();
});

// ---------- privacy screen blur ----------
// The actual blurring happens on the WhatsApp Web page itself (content.js);
// this button just flips the setting — background.js's saveSettings
// handler pushes it live to an already-open WA tab.
function renderPrivacyBlurToggle() {
  const on = !!STATE.settings.privacyBlur;
  const btn = document.getElementById('privacyBlurBtn');
  btn.classList.toggle('on', on);
  btn.dataset.tooltip = on
    ? 'Blurring chat names, photos & messages — click to turn off'
    : 'Blur chat names, photos & messages (screen-sharing)';
}

document.getElementById('privacyBlurBtn').addEventListener('click', async () => {
  const on = !!STATE.settings.privacyBlur;
  await call('saveSettings', { settings: { privacyBlur: !on } });
  refresh();
});

// Shows the shortcut Chrome actually has bound right now, not just the
// manifest's suggested default — the user may have already changed it
// (or cleared it) via chrome://extensions/shortcuts, which this can read
// but never write to; only Chrome's own page can rebind a command.
function renderPrivacyShortcut() {
  chrome.commands.getAll((commands) => {
    const cmd = (commands || []).find((c) => c.name === 'toggle-privacy-blur');
    document.getElementById('privacyShortcutKey').textContent = (cmd && cmd.shortcut) || 'Not set';
  });
}
document.getElementById('changeShortcutBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------- tabs ----------
// .just-selected is a one-shot trigger for the icon "key" pop/motion CSS
// (see popup.css's .tab-btn.just-selected rules) — added on click, removed
// after the animation finishes so clicking the same tab again re-triggers
// it instead of the class already being present doing nothing.
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    chrome.storage.local.set({ lastTab: btn.dataset.tab });
    btn.classList.remove('just-selected');
    void btn.offsetWidth; // force a reflow so re-adding the class restarts the animation
    btn.classList.add('just-selected');
    clearTimeout(btn._justSelectedTimer);
    btn._justSelectedTimer = setTimeout(() => btn.classList.remove('just-selected'), 450);
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
// Persisted (same pattern as lastTab/messageRunIds) so an expanded send panel
// stays expanded across closing and reopening the popup instead of silently
// collapsing back — the popup's JS state (including this variable) is
// destroyed and rebuilt from scratch every time it's reopened.
function setOpenSendPanel(id) {
  openSendPanelMessageId = id;
  chrome.storage.local.set({ openSendPanelMessageId: id });
}
chrome.storage.local.get(['openSendPanelMessageId'], (data) => {
  if (data.openSendPanelMessageId) {
    openSendPanelMessageId = data.openSendPanelMessageId;
    refresh();
  }
});

// buildSendPanel() is mounted in two places: under a message row (Messages
// tab, the original use) and inside the Campaigns tab's "new/edit campaign"
// flow, which mounts the exact same panel for a message picked there — same
// schedules, same storage, just a second doorway to it (no separate
// campaign entity). Whichever place currently has it mounted points this at
// its own re-render function, so the panel's internal actions (save
// schedule, toggle/run/delete, close) refresh the right tab instead of
// always assuming Messages. Reset to renderMessages by whichever context
// isn't using it, so it's never left pointing at a torn-down view.
let sendPanelRerender = renderMessages;
// Which message's schedule editor is mounted in the Campaigns tab's "new/
// edit campaign" flow, or null if just the message picker is showing.
// Mirrors openSendPanelMessageId's role for the Messages tab — only one of
// the two is ever open at a time app-wide (see the [data-act="send"] and
// campaign picker handlers, which each close the other).
let campaignEditorMessageId = null;

// Schedule-editor state for whichever message's send panel is currently
// open. A message can hold several schedules (each with its own target
// list(s) and timing); these track which one, if any, is being
// created/edited right now inside that panel — same "chips" pattern as
// composingItems, just scoped to one open panel instead of the whole tab.
let sendPanelMode = 'send'; // 'send' | 'schedule'
let editingScheduleId = null; // null = creating a new schedule
let scheduleType = 'times';
let scheduleTimes = [];
let scheduleDatetimes = [];

function resetScheduleEditor() {
  sendPanelMode = 'send';
  editingScheduleId = null;
  scheduleType = 'times';
  scheduleTimes = [];
  scheduleDatetimes = [];
  scheduleAdvancedOpen = false;
}

function startEditingSchedule(schedule) {
  sendPanelMode = 'schedule';
  editingScheduleId = schedule.id;
  scheduleType = schedule.scheduleType || 'times';
  scheduleTimes = (schedule.times || []).slice();
  scheduleDatetimes = (schedule.datetimes || []).filter(Boolean).slice();
  // Open Advanced by default when the schedule being edited actually has
  // something in there — otherwise a custom delay/label would be silently
  // hidden behind the collapsed section on every re-open.
  scheduleAdvancedOpen = !schedule.useDefaultDelay || !!(schedule.label && schedule.label.trim());
}

// Same field names as a schedule object (scheduleType/times/intervalMinutes/
// windowStart/windowEnd/datetimes) — used both for each schedule's row in
// "Scheduled sends for this message" and its delete-confirmation text.
function scheduleSummary(s) {
  if (!s) return 'unscheduled';
  if (s.scheduleType === 'times') {
    const times = s.times || [];
    return times.length ? `daily at ${times.join(', ')}` : 'no times set';
  }
  if (s.scheduleType === 'interval') {
    const minutes = s.intervalMinutes || 60;
    const everyText = minutes % 60 === 0 ? `every ${minutes / 60}h` : `every ${minutes}m`;
    const windowText = s.windowStart && s.windowEnd ? ` (${s.windowStart}–${s.windowEnd})` : '';
    return `${everyText}${windowText}`;
  }
  if (s.scheduleType === 'once') {
    const pending = (s.datetimes || []).filter(Boolean);
    return pending.length ? `${pending.length} one-time run(s) pending` : 'no runs pending';
  }
  return 'unscheduled';
}

// The in-progress compose form (label, text box, staged items) is a popup
// UI concern, not core app data — same pattern as lastTab — so it's read
// and written directly via chrome.storage.local rather than round-tripping
// through background.js. Without this, closing the popup (which destroys
// its JS state entirely) would silently discard an unsaved draft.
function saveDraft() {
  chrome.storage.local.set({
    messageDraft: {
      label: document.getElementById('msgLabel').value,
      text: document.getElementById('msgText').value,
      items: composingItems,
      editingMessageId,
      editingMessageSrNo,
      headerFooterMode: composingHfMode,
      headerText: composingHfHeaderText,
      footerText: composingHfFooterText,
      autoReply: composingAutoReply
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
    document.getElementById('msgText').value = draft.text || '';
    composingItems = draft.items || [];
    editingMessageId = draft.editingMessageId || null;
    editingMessageSrNo = typeof draft.editingMessageSrNo === 'number' ? draft.editingMessageSrNo : null;
    composingHfMode = draft.headerFooterMode || 'default';
    composingHfHeaderText = draft.headerText || '';
    composingHfFooterText = draft.footerText || '';
    composingAutoReply = draft.autoReply || defaultAutoReply();
    document.getElementById('msgLabelRow').style.display = editingMessageId ? '' : 'none';
    renderComposingItems();
    setBtnLabel('saveMessageBtn', editingMessageId ? 'Update message' : 'Save message');
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

// Shared by the file picker, drag-and-drop, and clipboard paste — every way
// a file can become an attachment funnels through here.
async function addMediaFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (files.length === 0) return;
  // If there's text sitting in the box that was never explicitly added as
  // its own thread (composingItems is still empty — either a fresh
  // message, or a single-text saved message being edited straight in the
  // box), commit it as a real thread first. Otherwise the moment an
  // attachment lands, composingItems stops being "empty" and
  // getEffectiveItems() would silently ignore that text at save/send time.
  if (composingItems.length === 0) {
    const textarea = document.getElementById('msgText');
    const pendingText = textarea.value.trim();
    if (pendingText) {
      composingItems.push({ kind: 'text', text: pendingText });
      textarea.value = '';
    }
  }
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      showToast(`"${file.name}" is larger than 15MB — WhatsApp Web may reject it.`, 'warning');
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
  renderComposingItems();
  saveDraft();
}

document.getElementById('msgFile').addEventListener('change', async (e) => {
  await addMediaFiles(e.target.files);
  document.getElementById('msgFile').value = '';
});

// "Screenshot_ddmmyy-hh.mm.ss" — pasted images have no real filename of
// their own, so this stands in for one, timestamped to when it was pasted.
const SCREENSHOT_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function screenshotFilename(mimeType) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(now.getDate())}${SCREENSHOT_MONTH_NAMES[now.getMonth()]}${pad(now.getFullYear() % 100)}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  const ext = (mimeType && mimeType.split('/')[1]) || 'png';
  return `Screenshot_${stamp}.${ext}`;
}

// Only intercepts when the clipboard actually holds image data — plain
// text paste (into any input, on any tab) is completely untouched.
document.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const images = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) images.push(new File([blob], screenshotFilename(item.type), { type: item.type }));
    }
  }
  if (images.length === 0) return;
  e.preventDefault();
  await addMediaFiles(images);
});

// Full-popup drag-and-drop: dragenter/dragleave are counted rather than
// just toggled, since moving over child elements fires both repeatedly as
// the cursor crosses their boundaries — only hide once the count is back
// to zero (actually left the window, not just crossed into a child).
let dragCounter = 0;
const dropOverlay = document.getElementById('dropOverlay');
function isFileDrag(e) {
  return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
}
function showDropOverlay() {
  dropOverlay.style.display = 'flex';
  requestAnimationFrame(() => dropOverlay.classList.add('show'));
}
function hideDropOverlay() {
  dropOverlay.classList.remove('show');
  setTimeout(() => {
    if (dragCounter === 0) dropOverlay.style.display = 'none';
  }, 150);
}
document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter++;
  showDropOverlay();
});
document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); // required for drop to be allowed at all
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) hideDropOverlay();
});
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter = 0;
  hideDropOverlay();
  await addMediaFiles(e.dataTransfer.files);
});

// Explicitly adding something (+ / Ctrl+Enter) always makes it a real,
// visible thread in the list below — even if it's the only one. The
// "just send whatever's in the box" shortcut (getEffectiveItems, used by
// Save/Send Now) is a completely separate path for when you *don't* click
// this at all; the two are no longer allowed to blend into each other.
function addTextThread() {
  const textarea = document.getElementById('msgText');
  const text = textarea.value.trim();
  if (!text) return;
  if (editingThreadItem) {
    // Editing an existing thread — update it in place, wherever it
    // currently sits (it may have been reordered since Edit was clicked).
    const idx = composingItems.indexOf(editingThreadItem);
    if (idx !== -1) composingItems[idx] = { kind: 'text', text };
    else composingItems.push({ kind: 'text', text }); // it was removed meanwhile — just add fresh
    editingThreadItem = null;
  } else {
    composingItems.push({ kind: 'text', text });
  }
  textarea.value = '';
  renderComposingItems();
  saveDraft();
}
document.getElementById('addTextItemBtn').addEventListener('click', addTextThread);
// Ctrl/Cmd+Enter does the same thing as the + button — plain Enter still
// just inserts a newline, same as any multi-line text box.
document.getElementById('msgText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
    quickSendToNumber();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    addTextThread();
  }
});

// ---------- country code picker (for the quick-send number box) ----------
// [iso2, dial, name] — dial codes are ITU country calling codes, stable and
// not something that changes. Sorted by name for the dropdown's default
// (unfiltered) order; search matches by name substring or by dial code
// (with or without a leading "+").
const COUNTRIES = [
  ['AF','93','Afghanistan'],['AL','355','Albania'],['DZ','213','Algeria'],['AD','376','Andorra'],
  ['AO','244','Angola'],['AG','1268','Antigua and Barbuda'],['AR','54','Argentina'],['AM','374','Armenia'],
  ['AU','61','Australia'],['AT','43','Austria'],['AZ','994','Azerbaijan'],['BS','1242','Bahamas'],
  ['BH','973','Bahrain'],['BD','880','Bangladesh'],['BB','1246','Barbados'],['BY','375','Belarus'],
  ['BE','32','Belgium'],['BZ','501','Belize'],['BJ','229','Benin'],['BT','975','Bhutan'],
  ['BO','591','Bolivia'],['BA','387','Bosnia and Herzegovina'],['BW','267','Botswana'],['BR','55','Brazil'],
  ['BN','673','Brunei'],['BG','359','Bulgaria'],['BF','226','Burkina Faso'],['BI','257','Burundi'],
  ['KH','855','Cambodia'],['CM','237','Cameroon'],['CA','1','Canada'],['CV','238','Cape Verde'],
  ['CF','236','Central African Republic'],['TD','235','Chad'],['CL','56','Chile'],['CN','86','China'],
  ['CO','57','Colombia'],['KM','269','Comoros'],['CD','243','Congo (DRC)'],['CG','242','Congo (Republic)'],
  ['CR','506','Costa Rica'],['HR','385','Croatia'],['CU','53','Cuba'],['CY','357','Cyprus'],
  ['CZ','420','Czech Republic'],['DK','45','Denmark'],['DJ','253','Djibouti'],['DM','1767','Dominica'],
  ['DO','1809','Dominican Republic'],['EC','593','Ecuador'],['EG','20','Egypt'],['SV','503','El Salvador'],
  ['GQ','240','Equatorial Guinea'],['ER','291','Eritrea'],['EE','372','Estonia'],['SZ','268','Eswatini'],
  ['ET','251','Ethiopia'],['FJ','679','Fiji'],['FI','358','Finland'],['FR','33','France'],
  ['GA','241','Gabon'],['GM','220','Gambia'],['GE','995','Georgia'],['DE','49','Germany'],
  ['GH','233','Ghana'],['GR','30','Greece'],['GD','1473','Grenada'],['GT','502','Guatemala'],
  ['GN','224','Guinea'],['GW','245','Guinea-Bissau'],['GY','592','Guyana'],['HT','509','Haiti'],
  ['HN','504','Honduras'],['HK','852','Hong Kong'],['HU','36','Hungary'],['IS','354','Iceland'],
  ['IN','91','India'],['ID','62','Indonesia'],['IR','98','Iran'],['IQ','964','Iraq'],
  ['IE','353','Ireland'],['IL','972','Israel'],['IT','39','Italy'],['CI','225',"Ivory Coast"],
  ['JM','1876','Jamaica'],['JP','81','Japan'],['JO','962','Jordan'],['KZ','7','Kazakhstan'],
  ['KE','254','Kenya'],['KI','686','Kiribati'],['XK','383','Kosovo'],['KW','965','Kuwait'],
  ['KG','996','Kyrgyzstan'],['LA','856','Laos'],['LV','371','Latvia'],['LB','961','Lebanon'],
  ['LS','266','Lesotho'],['LR','231','Liberia'],['LY','218','Libya'],['LI','423','Liechtenstein'],
  ['LT','370','Lithuania'],['LU','352','Luxembourg'],['MO','853','Macau'],['MG','261','Madagascar'],
  ['MW','265','Malawi'],['MY','60','Malaysia'],['MV','960','Maldives'],['ML','223','Mali'],
  ['MT','356','Malta'],['MH','692','Marshall Islands'],['MR','222','Mauritania'],['MU','230','Mauritius'],
  ['MX','52','Mexico'],['FM','691','Micronesia'],['MD','373','Moldova'],['MC','377','Monaco'],
  ['MN','976','Mongolia'],['ME','382','Montenegro'],['MA','212','Morocco'],['MZ','258','Mozambique'],
  ['MM','95','Myanmar'],['NA','264','Namibia'],['NR','674','Nauru'],['NP','977','Nepal'],
  ['NL','31','Netherlands'],['NZ','64','New Zealand'],['NI','505','Nicaragua'],['NE','227','Niger'],
  ['NG','234','Nigeria'],['KP','850','North Korea'],['MK','389','North Macedonia'],['NO','47','Norway'],
  ['OM','968','Oman'],['PK','92','Pakistan'],['PW','680','Palau'],['PS','970','Palestine'],
  ['PA','507','Panama'],['PG','675','Papua New Guinea'],['PY','595','Paraguay'],['PE','51','Peru'],
  ['PH','63','Philippines'],['PL','48','Poland'],['PT','351','Portugal'],['QA','974','Qatar'],
  ['RO','40','Romania'],['RU','7','Russia'],['RW','250','Rwanda'],['KN','1869','Saint Kitts and Nevis'],
  ['LC','1758','Saint Lucia'],['VC','1784','Saint Vincent and the Grenadines'],['WS','685','Samoa'],
  ['SM','378','San Marino'],['ST','239','Sao Tome and Principe'],['SA','966','Saudi Arabia'],
  ['SN','221','Senegal'],['RS','381','Serbia'],['SC','248','Seychelles'],['SL','232','Sierra Leone'],
  ['SG','65','Singapore'],['SK','421','Slovakia'],['SI','386','Slovenia'],['SB','677','Solomon Islands'],
  ['SO','252','Somalia'],['ZA','27','South Africa'],['KR','82','South Korea'],['SS','211','South Sudan'],
  ['ES','34','Spain'],['LK','94','Sri Lanka'],['SD','249','Sudan'],['SR','597','Suriname'],
  ['SE','46','Sweden'],['CH','41','Switzerland'],['SY','963','Syria'],['TW','886','Taiwan'],
  ['TJ','992','Tajikistan'],['TZ','255','Tanzania'],['TH','66','Thailand'],['TL','670','Timor-Leste'],
  ['TG','228','Togo'],['TO','676','Tonga'],['TT','1868','Trinidad and Tobago'],['TN','216','Tunisia'],
  ['TR','90','Turkey'],['TM','993','Turkmenistan'],['TV','688','Tuvalu'],['UG','256','Uganda'],
  ['UA','380','Ukraine'],['AE','971','United Arab Emirates'],['GB','44','United Kingdom'],
  ['US','1','United States'],['UY','598','Uruguay'],['UZ','998','Uzbekistan'],['VU','678','Vanuatu'],
  ['VA','379','Vatican City'],['VE','58','Venezuela'],['VN','84','Vietnam'],['YE','967','Yemen'],
  ['ZM','260','Zambia'],['ZW','263','Zimbabwe']
].map(([iso2, dial, name]) => ({ iso2, dial, name }));

// Real flag images (not emoji — Windows has no flag glyphs, so Chrome there
// just shows the raw two letters, "PK" instead of an actual flag; not a
// generated approximation either, actual per-country artwork). Downloaded
// from flagcdn.com exactly once — background.js's ensureFlagCache() does it
// right after install and stores the results as data URLs in
// chrome.storage.local, so there's never a repeat download on a normal
// popup open. This call is just the popup's own safety net (self-heals if
// the cache was cleared or partially written) — background.js's own
// ensureFlagCache short-circuits instantly when nothing's missing.
let flagCache = {};
call('ensureFlagsCached', {}).then((res) => {
  if (!res || !res.ok) return;
  flagCache = res.cache || {};
  // Re-render whatever's already on screen now that real flags are in —
  // matters the first time only (right after a fresh install, before the
  // cache exists yet); every later popup open already has it and this is a
  // no-op repaint of the same images.
  if (selectedCountry) document.getElementById('countryCodeFlag').innerHTML = flagIconHtml(selectedCountry.iso2);
  const dropdown = document.getElementById('countryCodeDropdown');
  if (dropdown.style.display !== 'none') renderCountryList(document.getElementById('countryCodeSearch').value);
});
function flagIconHtml(iso2) {
  const dataUrl = flagCache[iso2];
  if (dataUrl) return `<img class="cc-flag-img" src="${dataUrl}" width="20" height="14" alt="" />`;
  return '<span class="cc-flag-placeholder"></span>'; // only shown for the few seconds before the very first cache finishes
}

let selectedCountry = null;
chrome.storage.local.get(['quickSendCountryIso'], (data) => {
  if (data.quickSendCountryIso) {
    const c = COUNTRIES.find((x) => x.iso2 === data.quickSendCountryIso);
    if (c) selectCountry(c, { skipFocus: true });
  }
});

// Only updates the picker's own state/display — trimming a typed dial code
// back out of the number field (see the auto-detect input listener below)
// is the caller's job, not this function's, since a plain dropdown pick has
// nothing in the field to trim.
function selectCountry(country, { skipFocus = false } = {}) {
  selectedCountry = country;
  document.getElementById('countryCodeFlag').innerHTML = flagIconHtml(country.iso2);
  // Display is flag-only (no "+92" text alongside it) — the dial code still
  // shows up as the button's tooltip so it's not lost, just not cluttering
  // the row.
  document.getElementById('countryCodeBtn').dataset.tooltip = `${country.name} (+${country.dial})`;
  chrome.storage.local.set({ quickSendCountryIso: country.iso2 });
  closeCountryDropdown();
  if (!skipFocus) document.getElementById('quickSendNumber').focus();
}

function renderCountryList(filter) {
  const list = document.getElementById('countryCodeList');
  const q = (filter || '').trim().toLowerCase();
  const qDigits = q.replace(/^\+/, '');
  const matches = !q
    ? COUNTRIES
    : COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) || (qDigits && c.dial.startsWith(qDigits)));
  if (matches.length === 0) {
    list.innerHTML = '<p class="cc-no-match">No matching country.</p>';
    return;
  }
  list.innerHTML = matches
    .map(
      (c) => `<button type="button" class="cc-option${selectedCountry && selectedCountry.iso2 === c.iso2 ? ' active' : ''}" data-iso2="${c.iso2}">
        <span class="cc-flag">${flagIconHtml(c.iso2)}</span><span class="cc-name">${escapeHtml(c.name)}</span><span class="cc-code">+${c.dial}</span>
      </button>`
    )
    .join('');
  list.querySelectorAll('.cc-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = COUNTRIES.find((x) => x.iso2 === btn.dataset.iso2);
      if (c) selectCountry(c);
    });
  });
}

function openCountryDropdown() {
  document.getElementById('countryCodeDropdown').style.display = 'block';
  document.getElementById('countryCodeBtn').classList.add('open');
  const search = document.getElementById('countryCodeSearch');
  search.value = '';
  renderCountryList('');
  search.focus();
}
function closeCountryDropdown() {
  document.getElementById('countryCodeDropdown').style.display = 'none';
  document.getElementById('countryCodeBtn').classList.remove('open');
}
document.getElementById('countryCodeBtn').addEventListener('click', () => {
  const open = document.getElementById('countryCodeDropdown').style.display !== 'none';
  if (open) closeCountryDropdown();
  else openCountryDropdown();
});
document.getElementById('countryCodeSearch').addEventListener('input', (e) => renderCountryList(e.target.value));
document.getElementById('countryCodeSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCountryDropdown();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const first = document.querySelector('#countryCodeList .cc-option');
    if (first) first.click(); // top result of whatever's currently filtered — same one a mouse click on the first row would pick
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.country-code-picker')) closeCountryDropdown();
});

// Longest-dial-code-first match, so e.g. "+1246" resolves to Barbados
// rather than stopping at the shorter "+1" (US/Canada) prefix.
const COUNTRIES_BY_DIAL_LEN = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
function matchDialCode(digits) {
  return COUNTRIES_BY_DIAL_LEN.find((c) => digits.startsWith(c.dial));
}
// Typing (or pasting) a full international number straight into the number
// box — e.g. "+923344300709" — auto-selects the matching country and trims
// the dial code back out of the field, so the field always holds just the
// local number and the picker is the single source of truth for the dial
// code added at send time (never both at once).
document.getElementById('quickSendNumber').addEventListener('input', (e) => {
  const raw = e.target.value;
  if (!raw.trim().startsWith('+')) return;
  const digits = raw.replace(/\D/g, '');
  const match = matchDialCode(digits);
  if (match) {
    selectCountry(match, { skipFocus: true });
    e.target.value = digits.slice(match.dial.length);
  }
});

// Quick send — types a number above the composer and sends whatever's
// staged there (Ctrl+Shift+Enter or the send icon inside the number box)
// straight to it via sendNowToNumber, without saving anything or needing
// the number in a list first. Same getEffectiveItems() fallback as
// sendWithoutSavingBtn: an untouched box still sends whatever's typed.
async function quickSendToNumber() {
  const numberInput = document.getElementById('quickSendNumber');
  const localDigits = numberInput.value.replace(/\D/g, '');
  if (!localDigits) {
    showToast('Enter a phone number to quick-send to first.', 'error');
    numberInput.focus();
    return;
  }
  // A local number is usually typed with its trunk prefix ("0332...", the
  // "dial 0 to get an outside line" digit most numbering plans use) — that
  // 0 has to come off before the country's dial code goes on the front, or
  // the number is wrong (e.g. 0332... under +92 must send as 92332..., not
  // 920332...). Only touches the copy sent to background.js — the box
  // itself keeps showing exactly what was typed.
  const nationalDigits = selectedCountry ? localDigits.replace(/^0/, '') : localDigits;
  const number = (selectedCountry ? selectedCountry.dial : '') + nationalDigits;
  if (getEffectiveItems().length === 0) {
    showToast('Add at least one text thread or attachment first.', 'error');
    return;
  }
  if (!STATE.settings.consentAccepted) {
    showToast('Accept the consent checkbox on the Settings tab first — sending is gated behind it, even for a quick send.', 'error');
    return;
  }
  const btn = document.getElementById('quickSendBtn');
  btn.disabled = true;
  const messageOverride = { headerFooterMode: composingHfMode, headerText: composingHfHeaderText, footerText: composingHfFooterText };
  const res = await call('sendNowToNumber', {
    number,
    items: getEffectiveItems(),
    sendSeparator: sendPanelSeparatorPref,
    messageOverride
  });
  btn.disabled = false;
  if (!res.ok) {
    showToast(res.error || 'Could not send.', 'error');
    return;
  }
  showToast(`Sending to ${res.chatName || number}…`, 'success');
  numberInput.value = ''; // only the number clears — text/attachments stay, same as Send Now leaves the composer untouched
}
document.getElementById('quickSendBtn').addEventListener('click', quickSendToNumber);
document.getElementById('quickSendNumber').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
    quickSendToNumber();
  }
});

// A single quick message shouldn't need the extra "+" click: if nothing's
// been explicitly added as a thread/attachment yet, Save/Send fall back to
// whatever's currently typed in the box, used as-is for just that one
// action. This never touches composingItems or the box itself — nothing
// gets added to the thread list, nothing gets cleared — building an actual
// multi-thread message is still entirely up to "+"/attach, done by hand.
function getEffectiveItems() {
  if (composingItems.length > 0) return composingItems;
  const text = document.getElementById('msgText').value.trim();
  return text ? [{ kind: 'text', text }] : [];
}

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
// Both live inside the composing-list box itself now (a small toolbar row
// above the items), not as standalone buttons outside it — they only mean
// anything once there's at least one item, so they only appear then too.
function handleFillCaptions() {
  let filled = 0;
  composingItems.forEach((item) => {
    if (item.kind === 'media' && !item.caption) {
      item.caption = stripExtension(item.media.filename);
      filled++;
    }
  });
  if (filled === 0) {
    showToast('No attachments with an empty caption to fill.', 'info');
    return;
  }
  renderComposingItems();
  saveDraft();
}

async function handleClearAllItems() {
  if (composingItems.length === 0) return;
  const ok = await showConfirmDialog('Remove all items from this message?', { confirmText: 'Remove all', danger: true });
  if (!ok) return;
  composingItems = [];
  editingThreadItem = null;
  hfPanelItem = null;
  bulkHfPanelOpen = false;
  renderComposingItems();
  saveDraft();
}

// Loads a thread's text into the box for editing — the card stays put in
// the list (just highlighted) rather than disappearing; "+"/Ctrl+Enter
// updates it in place wherever it ends up, instead of adding a new one.
function editTextThread(idx) {
  const item = composingItems[idx];
  if (!item || item.kind !== 'text') return;
  const textarea = document.getElementById('msgText');
  textarea.value = item.text;
  editingThreadItem = item;
  renderComposingItems();
  saveDraft();
  textarea.focus();
}

// Shared radio-group+textarea markup for a header/footer override panel —
// used by both the whole-message control and each per-thread one below it.
// Default/Custom/Off are mutually exclusive, so real radio inputs (themed
// via accent-color, same as this app's checkboxes) rather than
// toggle-button chips — `groupName` keeps the message-level and per-thread
// radio groups from cross-syncing (only one of each is ever in the DOM at
// once, but they'd still share native radio-group state if both used the
// same `name`). `inheritHint` names what "Default" falls back to.
// `extraHtml` is appended inside the panel — used for the bulk tool's
// "Apply to all" button, which no other caller needs.
function hfPanelHtml(mode, headerText, footerText, scopeLabel, inheritHint, groupName, extraHtml = '') {
  const radios = ['default', 'custom', 'off']
    .map(
      (m) => `<label class="hf-radio-option">
        <input type="radio" name="${groupName}" value="${m}"${mode === m ? ' checked' : ''} />
        <span>${m === 'default' ? 'Default' : m === 'custom' ? 'Custom' : 'Off'}</span>
      </label>`
    )
    .join('');
  let body;
  if (mode === 'custom') {
    body = `<textarea class="hf-header-input" placeholder="Header text" rows="2">${escapeHtml(headerText || '')}</textarea><textarea class="hf-footer-input" placeholder="Footer text" rows="2">${escapeHtml(footerText || '')}</textarea>`;
  } else if (mode === 'off') {
    body = `<p class="hf-panel-hint">No header or footer will be added to ${scopeLabel}.</p>`;
  } else {
    body = `<p class="hf-panel-hint">Uses ${inheritHint}.</p>`;
  }
  return `<div class="hf-panel"><div class="hf-mode-radios">${radios}</div>${body}${extraHtml}</div>`;
}

// Header/footer for the whole message being composed — see the
// composingHfMode declaration above for the resolution order. The toggle
// button itself is static markup right in the icon row next to +/attach
// (popup.html) so it's always visible, even before anything's been added
// to the message — only its open/mode-dot state and the expandable panel
// below it are re-rendered here.
function renderMessageHfControl() {
  const toggleBtn = document.getElementById('msgHfToggleBtn');
  const dot = document.getElementById('msgHfDot');
  const container = document.getElementById('msgHeaderFooterControl');
  if (!toggleBtn || !dot || !container) return;
  toggleBtn.classList.toggle('open', messageHfPanelOpen);
  dot.style.display = composingHfMode === 'default' ? 'none' : '';
  dot.className = `hf-dot ${composingHfMode}`;
  container.innerHTML = messageHfPanelOpen
    ? hfPanelHtml(composingHfMode, composingHfHeaderText, composingHfFooterText, 'this message', 'the global header/footer set on the Settings tab', 'hfMode-message')
    : '';
  if (!messageHfPanelOpen) return;
  container.querySelectorAll('input[name="hfMode-message"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      composingHfMode = e.target.value;
      saveDraft();
      renderMessageHfControl();
    });
  });
  const headerInput = container.querySelector('.hf-header-input');
  const footerInput = container.querySelector('.hf-footer-input');
  if (headerInput) {
    headerInput.addEventListener('input', (e) => {
      composingHfHeaderText = e.target.value;
      saveDraft();
    });
  }
  if (footerInput) {
    footerInput.addEventListener('input', (e) => {
      composingHfFooterText = e.target.value;
      saveDraft();
    });
  }
}
document.getElementById('msgHfToggleBtn').addEventListener('click', () => {
  messageHfPanelOpen = !messageHfPanelOpen;
  renderMessageHfControl();
});

// ---------- auto-reply panel (compose form) ----------
function autoReplyTriggerRowHtml(t, idx) {
  const isRegex = t.type === 'regex';
  return `
    <div class="ar-trigger-row" data-idx="${idx}">
      <select class="ar-trigger-type">
        <option value="phrase"${isRegex ? '' : ' selected'}>Phrase</option>
        <option value="regex"${isRegex ? ' selected' : ''}>Regex</option>
      </select>
      <input type="text" class="ar-trigger-value" placeholder="${isRegex ? 'e.g. hotel\\s*dates?' : 'e.g. hotel dates'}" value="${escapeHtml(t.value || '')}" />
      <label class="ar-case-label" data-tooltip="Case sensitive"><input type="checkbox" class="ar-trigger-case"${t.caseSensitive ? ' checked' : ''} />Aa</label>
      <button type="button" class="icon-btn small-icon-btn ar-trigger-remove" data-tooltip="Remove trigger">${DELETE_ICON_SVG}</button>
    </div>`;
}

function autoReplyPanelHtml(ar) {
  const rows = (ar.triggers || []).map((t, i) => autoReplyTriggerRowHtml(t, i)).join('');
  return `
    <div class="hf-panel ar-panel">
      <label class="ar-enable-row">
        <input type="checkbox" class="ar-enabled-checkbox"${ar.enabled ? ' checked' : ''} />
        <span>Auto-reply with this message when a trigger below matches an incoming chat/group message</span>
      </label>
      <p class="hf-panel-hint">Sends instantly, no delay — only while a WhatsApp Web tab is open. Never triggers on your own messages.</p>
      <div class="ar-triggers">${rows || '<p class="hf-panel-hint">No triggers yet — add one below.</p>'}</div>
      <button type="button" class="ghost small-inline ar-add-trigger-btn"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg><span class="btn-label">Add trigger</span></button>
      <div class="ar-cooldown-row">
        <label><input type="checkbox" class="ar-cooldown-enabled-checkbox"${ar.cooldownEnabled ? ' checked' : ''} /> Limit repeats: once every</label>
        <input type="number" class="ar-cooldown-value-input" min="0" step="1" value="${ar.cooldownValue != null ? ar.cooldownValue : 60}"${ar.cooldownEnabled ? '' : ' disabled'} />
        <select class="ar-cooldown-unit-select"${ar.cooldownEnabled ? '' : ' disabled'}>
          <option value="seconds"${ar.cooldownUnit === 'seconds' ? ' selected' : ''}>seconds</option>
          <option value="minutes"${!ar.cooldownUnit || ar.cooldownUnit === 'minutes' ? ' selected' : ''}>minutes</option>
          <option value="hours"${ar.cooldownUnit === 'hours' ? ' selected' : ''}>hours</option>
        </select>
        <span>per chat</span>
      </div>
    </div>`;
}

// Shared editor for an autoReply object, used both by the compose form's
// collapsible panel and by the standalone Auto-reply tab's per-message row.
// `ar` is mutated in place; `persist(ar)` is called after every change so
// each caller decides how/when that lands in storage (the compose form
// just keeps it in the in-progress draft until "Save message"; the
// Auto-reply tab saves the message immediately, since there's no separate
// compose step there). Scoped entirely to `container` via querySelector
// (never getElementById) so two instances of this panel can exist in the
// DOM at once — the compose form's and a tab row's — without id clashes.
function bindAutoReplyPanel(container, ar, persist) {
  function rerender() {
    container.innerHTML = autoReplyPanelHtml(ar);
    wire();
  }
  function wire() {
    container.querySelector('.ar-enabled-checkbox').addEventListener('change', (e) => {
      ar.enabled = e.target.checked;
      persist(ar);
      rerender();
    });
    container.querySelectorAll('.ar-trigger-row').forEach((row) => {
      const idx = Number(row.dataset.idx);
      row.querySelector('.ar-trigger-type').addEventListener('change', (e) => {
        ar.triggers[idx].type = e.target.value;
        persist(ar);
        rerender();
      });
      row.querySelector('.ar-trigger-value').addEventListener('input', (e) => {
        ar.triggers[idx].value = e.target.value;
        persist(ar);
      });
      row.querySelector('.ar-trigger-case').addEventListener('change', (e) => {
        ar.triggers[idx].caseSensitive = e.target.checked;
        persist(ar);
      });
      row.querySelector('.ar-trigger-remove').addEventListener('click', () => {
        ar.triggers.splice(idx, 1);
        persist(ar);
        rerender();
      });
    });
    container.querySelector('.ar-add-trigger-btn').addEventListener('click', () => {
      ar.triggers.push({ type: 'phrase', value: '', caseSensitive: false });
      persist(ar);
      rerender();
    });
    container.querySelector('.ar-cooldown-enabled-checkbox').addEventListener('change', (e) => {
      ar.cooldownEnabled = e.target.checked;
      persist(ar);
      rerender();
    });
    const cooldownValueInput = container.querySelector('.ar-cooldown-value-input');
    if (cooldownValueInput) {
      cooldownValueInput.addEventListener('input', (e) => {
        ar.cooldownValue = e.target.value === '' ? 0 : Number(e.target.value);
        persist(ar);
      });
    }
    const cooldownUnitSelect = container.querySelector('.ar-cooldown-unit-select');
    if (cooldownUnitSelect) {
      cooldownUnitSelect.addEventListener('change', (e) => {
        ar.cooldownUnit = e.target.value;
        persist(ar);
      });
    }
  }
  rerender();
}

function renderMessageAutoReplyControl() {
  const toggleBtn = document.getElementById('msgAutoReplyToggleBtn');
  const dot = document.getElementById('msgAutoReplyDot');
  const container = document.getElementById('msgAutoReplyControl');
  if (!toggleBtn || !dot || !container) return;
  toggleBtn.classList.toggle('open', messageAutoReplyPanelOpen);
  dot.style.display = composingAutoReply.enabled ? '' : 'none';
  dot.className = 'hf-dot custom';
  if (!messageAutoReplyPanelOpen) {
    container.innerHTML = '';
    return;
  }
  // composingAutoReply is passed directly (not a copy) — bindAutoReplyPanel
  // mutates it in place, and saveDraft() below just reads that same
  // module-level object, exactly like composingHfMode's own textareas do.
  bindAutoReplyPanel(container, composingAutoReply, () => saveDraft());
}
document.getElementById('msgAutoReplyToggleBtn').addEventListener('click', () => {
  messageAutoReplyPanelOpen = !messageAutoReplyPanelOpen;
  renderMessageAutoReplyControl();
});

function renderComposingItems() {
  renderMessageHfControl();
  renderMessageAutoReplyControl();
  const box = document.getElementById('composingItems');
  // Nothing to show or manage yet — hide the whole section rather than a
  // box with a placeholder hint inside it; the textarea's own placeholder
  // already tells you how to add something.
  if (composingItems.length === 0) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  // Once something's been explicitly added (+ / Ctrl+Enter, or an
  // attachment), it always shows here — even if it's the only one. Only
  // *not yet added* content skips this and lives purely in the box (see
  // getEffectiveItems, used by Save/Send Now).
  box.style.display = '';
  const hasText = composingItems.some((item) => item.kind === 'text');
  const hasMedia = composingItems.some((item) => item.kind === 'media');
  // All-text = "Threads", all-attachments = "Attachments", a mix of both
  // (or, in principle, neither) = the generic "Items".
  const sectionLabel = hasText && hasMedia ? 'Items' : hasMedia ? 'Attachments' : hasText ? 'Threads' : 'Items';
  // "Apply to all" copies bulkHfMode/HeaderText/FooterText onto every item
  // below when clicked — nothing changes just from opening this panel or
  // picking a mode, only the explicit Apply button commits it.
  const bulkHfPanel = bulkHfPanelOpen
    ? `<div class="bulk-hf-wrap">${hfPanelHtml(
        bulkHfMode,
        bulkHfHeaderText,
        bulkHfFooterText,
        'every thread/attachment below',
        'the message header/footer setting',
        'hfMode-bulk',
        `<button type="button" class="ghost small-inline hf-bulk-apply-btn">${CHECK_ICON_SVG}<span class="btn-label">Apply to all below</span></button>`
      )}</div>`
    : '';
  const toolbarHtml = `<div class="composing-toolbar">
    <span class="muted">${sectionLabel} (${composingItems.length})</span>
    <div class="composing-toolbar-actions">
      <button type="button" class="icon-btn small-icon-btn${bulkHfPanelOpen ? ' open' : ''}" data-act="bulkHf" data-tooltip="Set header/footer for every thread/attachment at once">${HF_ICON_SVG}</button>
      <button type="button" class="icon-btn small-icon-btn" data-act="fillCaptions" data-tooltip="Use file names as captions">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16Z"/></svg>
      </button>
      <button type="button" class="icon-btn small-icon-btn danger" data-act="clearAll" data-tooltip="Remove all items from this message">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg>
      </button>
    </div>
  </div>${bulkHfPanel}`;
  box.innerHTML =
    toolbarHtml +
    composingItems
      .map((item, i) => {
      const icon = item.kind === 'media' ? MEDIA_ICON_SVG : TEXT_ICON_SVG;
      const preview =
        item.kind === 'media'
          ? escapeHtml(item.media.filename)
          : escapeHtml(item.text.slice(0, 80));
      const captionField =
        item.kind === 'media'
          ? `<textarea class="caption-input" data-idx="${i}" placeholder="Caption (optional)" rows="2">${escapeHtml(item.caption || '')}</textarea>`
          : '';
      const isEditing = item === editingThreadItem;
      const hfMode = item.headerFooterMode || 'default';
      const hfBadge =
        hfMode !== 'default'
          ? `<span class="hf-mode-badge ${hfMode}">${hfMode === 'custom' ? 'Custom H/F' : 'No H/F'}</span>`
          : '';
      const hfPanelOpen = item === hfPanelItem;
      const hfPanel = hfPanelOpen
        ? hfPanelHtml(hfMode, item.headerText, item.footerText, 'this thread', "this message's header/footer setting", 'hfMode-thread')
        : '';
      return `<div class="composing-item${isEditing ? ' editing' : ''}">
        <input type="number" class="item-srno-input" data-idx="${i}" min="1" max="${composingItems.length}" value="${i + 1}" data-tooltip="Thread number — change it to move this item to that position" />
        <span class="composing-item-icon ${item.kind}">${icon}</span>
        <div class="composing-item-body">
          <div class="composing-item-preview">${preview}</div>
          ${isEditing ? '<span class="muted composing-item-editing-note">Editing — update or Ctrl+Enter above</span>' : ''}
          ${hfBadge}
          ${captionField}
          ${hfPanel}
        </div>
        <div class="composing-item-actions">
          ${item.kind === 'text' ? `<button type="button" data-act="edit" data-idx="${i}" data-tooltip="Edit this thread">${EDIT_ICON_SVG}</button>` : ''}
          <button type="button" data-act="hf" data-idx="${i}" class="hf-item-toggle${hfPanelOpen ? ' open' : ''}" data-tooltip="Header/footer for this thread — overrides the message setting">${HF_ICON_SVG}</button>
          <button type="button" data-act="up" data-idx="${i}" data-tooltip="Move up">${MOVE_UP_ICON_SVG}</button>
          <button type="button" data-act="down" data-idx="${i}" data-tooltip="Move down">${MOVE_DOWN_ICON_SVG}</button>
          <button type="button" data-act="remove" data-idx="${i}" data-tooltip="Remove">${REMOVE_ICON_SVG}</button>
        </div>
      </div>`;
    })
    .join('');

  const fillCaptionsBtn = box.querySelector('[data-act="fillCaptions"]');
  if (fillCaptionsBtn) fillCaptionsBtn.addEventListener('click', handleFillCaptions);
  const clearAllBtn = box.querySelector('[data-act="clearAll"]');
  if (clearAllBtn) clearAllBtn.addEventListener('click', handleClearAllItems);

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
  box.querySelectorAll('[data-act="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => editTextThread(Number(btn.dataset.idx)));
  });
  box.querySelectorAll('[data-act="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [removed] = composingItems.splice(Number(btn.dataset.idx), 1);
      if (removed === editingThreadItem) editingThreadItem = null;
      if (removed === hfPanelItem) hfPanelItem = null;
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
  box.querySelectorAll('[data-act="hf"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = composingItems[Number(btn.dataset.idx)];
      hfPanelItem = hfPanelItem === item ? null : item;
      renderComposingItems();
    });
  });
  if (hfPanelItem) {
    box.querySelectorAll('input[name="hfMode-thread"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        hfPanelItem.headerFooterMode = e.target.value;
        renderComposingItems();
        saveDraft();
      });
    });
    // Scoped to inside a .composing-item specifically — the bulk tool's
    // panel (below) can be open in the same box at the same time and has
    // matching .hf-header-input/.hf-footer-input fields of its own.
    const hfHeaderInput = box.querySelector('.composing-item .hf-header-input');
    const hfFooterInput = box.querySelector('.composing-item .hf-footer-input');
    if (hfHeaderInput) {
      hfHeaderInput.addEventListener('input', (e) => {
        hfPanelItem.headerText = e.target.value;
        saveDraft();
      });
    }
    if (hfFooterInput) {
      hfFooterInput.addEventListener('input', (e) => {
        hfPanelItem.footerText = e.target.value;
        saveDraft();
      });
    }
  }
  const bulkHfBtn = box.querySelector('[data-act="bulkHf"]');
  if (bulkHfBtn) {
    bulkHfBtn.addEventListener('click', () => {
      bulkHfPanelOpen = !bulkHfPanelOpen;
      renderComposingItems();
    });
  }
  if (bulkHfPanelOpen) {
    box.querySelectorAll('input[name="hfMode-bulk"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        bulkHfMode = e.target.value;
        renderComposingItems();
      });
    });
    const bulkHeaderInput = box.querySelector('.bulk-hf-wrap .hf-header-input');
    const bulkFooterInput = box.querySelector('.bulk-hf-wrap .hf-footer-input');
    if (bulkHeaderInput) {
      bulkHeaderInput.addEventListener('input', (e) => {
        bulkHfHeaderText = e.target.value;
      });
    }
    if (bulkFooterInput) {
      bulkFooterInput.addEventListener('input', (e) => {
        bulkHfFooterText = e.target.value;
      });
    }
    const applyBtn = box.querySelector('.hf-bulk-apply-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        const overrideCount = composingItems.filter(
          (it) => it.headerFooterMode && it.headerFooterMode !== 'default'
        ).length;
        if (overrideCount > 0) {
          const ok = await showConfirmDialog(
            `Apply this to all ${composingItems.length} item(s) below? ${overrideCount} of them currently have their own header/footer setting — it'll be replaced.`,
            { confirmText: 'Apply to all', danger: true }
          );
          if (!ok) return;
        }
        composingItems.forEach((it) => {
          it.headerFooterMode = bulkHfMode;
          it.headerText = bulkHfHeaderText;
          it.footerText = bulkHfFooterText;
        });
        bulkHfPanelOpen = false;
        hfPanelItem = null;
        renderComposingItems();
        saveDraft();
        showToast(`Header/footer applied to ${composingItems.length} item(s).`, 'success');
      });
    }
  }
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
  editingMessageSrNo = null;
  editingThreadItem = null;
  hfPanelItem = null;
  bulkHfPanelOpen = false;
  bulkHfMode = 'default';
  bulkHfHeaderText = '';
  bulkHfFooterText = '';
  composingItems = [];
  composingHfMode = 'default';
  composingHfHeaderText = '';
  composingHfFooterText = '';
  messageHfPanelOpen = false;
  composingAutoReply = defaultAutoReply();
  messageAutoReplyPanelOpen = false;
  document.getElementById('msgLabel').value = '';
  document.getElementById('msgLabelRow').style.display = 'none';
  document.getElementById('msgText').value = '';
  document.getElementById('msgFile').value = '';
  renderComposingItems();
  setBtnLabel('saveMessageBtn', 'Save message');
  document.getElementById('cancelEditMessageBtn').style.display = 'none';
  adhocSendPanelOpen = false;
  renderAdhocSendPanel();
  clearDraft();
}

document.getElementById('cancelEditMessageBtn').addEventListener('click', resetMessageForm);

// "Send Now" — sends whatever's currently staged in the composer straight
// out via sendNowAdhoc, without ever creating a saved message. Only
// whole-list targeting (no per-chat member picking, no per-item selection)
// — this is the fast path, not a replacement for the full send panel a
// saved message gets.
document.getElementById('sendWithoutSavingBtn').addEventListener('click', () => {
  if (getEffectiveItems().length === 0) {
    showToast('Add at least one text thread or attachment first.', 'error');
    return;
  }
  if (!STATE.settings.consentAccepted) {
    showToast('Accept the consent checkbox on the Settings tab first — sending is gated behind it, even for a one-off send.', 'error');
    return;
  }
  adhocSendPanelOpen = !adhocSendPanelOpen;
  renderAdhocSendPanel();
});

function renderAdhocSendPanel() {
  const container = document.getElementById('adhocSendPanelContainer');
  if (!container) return;
  container.innerHTML = '';
  if (!adhocSendPanelOpen && !adhocRunEntry) return;

  const panel = document.createElement('div');
  panel.className = 'send-panel';

  const run = adhocRunEntry ? STATE.activeRuns[adhocRunEntry.runId] : null;
  if (adhocRunEntry && !run) {
    // Same short grace window as messageRunIds/deleteRunEntry — background.js
    // hasn't necessarily written the run's progress record yet.
    if (Date.now() - (adhocRunEntry.assignedAt || 0) < 8000) {
      panel.innerHTML = '<p class="hint">Starting…</p>';
      container.appendChild(panel);
      return;
    }
    setAdhocRunId(null);
  }
  if (run) {
    panel.innerHTML = `
      ${renderProgressBlock(run)}
      ${run.done ? `<button class="ghost small-inline" type="button" data-act="closeAdhoc">${CHECK_ICON_SVG}<span class="btn-label">Close</span></button>` : '<p class="hint">Sending — this updates live.</p>'}
    `;
    const closeBtn = panel.querySelector('[data-act="closeAdhoc"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        setAdhocRunId(null);
        adhocSendPanelOpen = false;
        renderAdhocSendPanel();
      });
    }
    container.appendChild(panel);
    return;
  }

  if (STATE.lists.length === 0) {
    panel.innerHTML = '<p class="hint">Build a list first (Lists tab) before you can send.</p>';
    container.appendChild(panel);
    return;
  }

  panel.innerHTML = `
    <p class="hint">Sends the ${getEffectiveItems().length} item(s) above once, right now — nothing is saved to your message library.</p>
    <div class="checklist">
      ${STATE.lists
        .map((l) => {
          const members = l.members || [];
          const selected = listSelectionSetFor(ADHOC_DRAFT_KEY, l.id);
          const selectedCount = members.filter((m) => selected.has(m.waId)).length;
          const expandKey = `${ADHOC_DRAFT_KEY}:${l.id}`;
          const expanded = expandedListPanels.has(expandKey);
          return `<div class="list-check-row">
            <label class="checkbox-row list-check-label">
              <input type="checkbox" class="adhoc-list-check" value="${l.id}" ${selectedCount === members.length && members.length > 0 ? 'checked' : ''} ${selectedCount > 0 && selectedCount < members.length ? 'data-indeterminate="1"' : ''} />
              ${escapeHtml(l.name)} <span class="muted badge-count-${l.id}">(${selectedCount}/${members.length})</span>
            </label>
            ${
              members.length > 0
                ? `<button class="icon-btn small-icon-btn list-expand-btn${expanded ? ' expanded' : ''}" type="button" data-act="toggleAdhocListMembers" data-list-id="${l.id}" data-tooltip="Choose which chats in this list">
              <svg class="chevron-icon${expanded ? ' expanded' : ''}" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            </button>`
                : ''
            }
          </div>
          ${
            members.length > 0
              ? `<div class="list-members" data-list-id="${l.id}" style="display:${expanded ? '' : 'none'}">
            ${members
              .map(
                (m) =>
                  `<label class="checkbox-row list-member-row"><input type="checkbox" class="adhoc-member-check" data-list-id="${l.id}" data-wa-id="${escapeHtml(m.waId)}" ${selected.has(m.waId) ? 'checked' : ''} /> ${escapeHtml(m.name || m.waId)}</label>`
              )
              .join('')}
          </div>`
              : ''
          }`;
        })
        .join('')}
    </div>
    <div class="send-panel-actions">
      <label class="checkbox-row send-separator-check-row">
        <input type="checkbox" class="send-separator-check" ${sendPanelSeparatorPref ? 'checked' : ''} />
        Send a "➖" separator after each item
      </label>
      <button class="primary" type="button" data-act="confirmAdhocSend">${SEND_ICON_SVG}<span class="btn-label">Send now</span></button>
      <button class="ghost small-inline" type="button" data-act="cancelAdhocSend">${CLOSE_ICON_SVG}<span class="btn-label">Cancel</span></button>
    </div>
  `;
  panel.querySelectorAll('.adhoc-list-check').forEach((cb) => {
    cb.indeterminate = cb.hasAttribute('data-indeterminate');
  });
  panel.querySelectorAll('[data-act="toggleAdhocListMembers"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const listId = btn.dataset.listId;
      const key = `${ADHOC_DRAFT_KEY}:${listId}`;
      const membersEl = panel.querySelector(`.list-members[data-list-id="${listId}"]`);
      const nowExpanded = membersEl.style.display === 'none';
      membersEl.style.display = nowExpanded ? '' : 'none';
      btn.classList.toggle('expanded', nowExpanded);
      const chevron = btn.querySelector('.chevron-icon');
      if (chevron) chevron.classList.toggle('expanded', nowExpanded);
      if (nowExpanded) expandedListPanels.add(key);
      else expandedListPanels.delete(key);
    });
  });
  function updateAdhocListCheckboxState(listId) {
    const list = STATE.lists.find((l) => l.id === listId);
    if (!list) return;
    const members = list.members || [];
    const selected = listSelectionSetFor(ADHOC_DRAFT_KEY, listId);
    const selectedCount = members.filter((m) => selected.has(m.waId)).length;
    const badge = panel.querySelector(`.badge-count-${listId}`);
    if (badge) badge.textContent = `(${selectedCount}/${members.length})`;
    const listCb = panel.querySelector(`.adhoc-list-check[value="${listId}"]`);
    if (listCb) {
      listCb.checked = selectedCount > 0 && selectedCount === members.length;
      listCb.indeterminate = selectedCount > 0 && selectedCount < members.length;
    }
  }
  panel.querySelectorAll('.adhoc-member-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const listId = cb.dataset.listId;
      const selected = listSelectionSetFor(ADHOC_DRAFT_KEY, listId);
      if (cb.checked) selected.add(cb.dataset.waId);
      else selected.delete(cb.dataset.waId);
      saveListSelections();
      updateAdhocListCheckboxState(listId);
    });
  });
  // The list's own checkbox doubles as select-all/none for its members, same
  // as the per-message send panel — selecting the list itself, or just some
  // chats within it (without ever touching the list checkbox), both count
  // as "part of this send" (see confirmAdhocSend below).
  panel.querySelectorAll('.adhoc-list-check').forEach((listCb) => {
    listCb.addEventListener('change', () => {
      const listId = listCb.value;
      const memberChecks = panel.querySelectorAll(`.adhoc-member-check[data-list-id="${listId}"]`);
      const selected = listSelectionSetFor(ADHOC_DRAFT_KEY, listId);
      memberChecks.forEach((cb) => {
        cb.checked = listCb.checked;
        if (listCb.checked) selected.add(cb.dataset.waId);
        else selected.delete(cb.dataset.waId);
      });
      saveListSelections();
      updateAdhocListCheckboxState(listId);
    });
  });
  const cancelBtn = panel.querySelector('[data-act="cancelAdhocSend"]');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      adhocSendPanelOpen = false;
      renderAdhocSendPanel();
    });
  }
  const separatorCheck = panel.querySelector('.send-separator-check');
  if (separatorCheck) {
    separatorCheck.addEventListener('change', () => {
      sendPanelSeparatorPref = separatorCheck.checked;
      chrome.storage.local.set({ sendPanelSeparatorPref });
    });
  }
  const confirmBtn = panel.querySelector('[data-act="confirmAdhocSend"]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const memberFilter = {};
      const listIds = [];
      for (const l of STATE.lists) {
        const members = l.members || [];
        if (members.length === 0) continue;
        const selected = listSelectionSetFor(ADHOC_DRAFT_KEY, l.id);
        const selectedWaIds = members.filter((m) => selected.has(m.waId)).map((m) => m.waId);
        if (selectedWaIds.length === 0) continue;
        listIds.push(l.id);
        if (selectedWaIds.length < members.length) memberFilter[l.id] = selectedWaIds;
      }
      if (listIds.length === 0) {
        showToast('Select at least one chat to send to.', 'error');
        return;
      }
      const sendSeparator = panel.querySelector('.send-separator-check').checked;
      // Not saved as a message, so there's no message row to carry the
      // header/footer mode set in the compose form above — passed through
      // directly instead, so it still takes effect for this one send.
      const messageOverride = { headerFooterMode: composingHfMode, headerText: composingHfHeaderText, footerText: composingHfFooterText };
      const res = await call('sendNowAdhoc', { items: getEffectiveItems(), listIds, memberFilter, sendSeparator, messageOverride });
      if (res.ok && res.runId) {
        setAdhocRunId(res.runId);
      } else if (!res.ok) {
        showToast(res.error || 'Could not send.', 'error');
      }
      renderAdhocSendPanel();
    });
  }

  container.appendChild(panel);
}

document.getElementById('saveMessageBtn').addEventListener('click', async () => {
  const label = document.getElementById('msgLabel').value.trim();
  const items = getEffectiveItems();
  if (items.length === 0) {
    showToast('Add at least one text thread or attachment first.', 'error');
    return;
  }
  const first = items[0];
  const name = label || (first.kind === 'media' ? first.media.filename : first.text.slice(0, 30));
  // Editing an existing message keeps its current list position; a new one
  // is appended after whatever's already there. Reordering after the fact
  // is what the ▲/▼ buttons on the saved-message row are for.
  const srNo = editingMessageId ? editingMessageSrNo : nextSrNo();
  const message = {
    id: editingMessageId,
    name,
    srNo,
    items,
    headerFooterMode: composingHfMode,
    headerText: composingHfHeaderText,
    footerText: composingHfFooterText,
    autoReply: composingAutoReply
  };
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

// Saved-message row actions: Send/Schedule (the chevron) and the quick
// "send to current chat" button stay directly on the row since they DO
// something with the message; Edit/Move up/Move down/Delete are "manage
// this message" actions rather than "send" ones, and with all six as
// separate icons the row was overflowing/wrapping at the neumorphic
// buttons' size — folded into a "more" overflow menu instead of shrinking
// everything to cram it back in, since fewer visible icons is the fix,
// not smaller ones. Only one row's menu open at a time, closed by
// clicking anywhere else (this listener is added once here, not per
// render — renderMessages() runs on every refresh/toggle).
let messageOverflowMenuId = null;
document.addEventListener('click', () => {
  if (messageOverflowMenuId !== null) {
    messageOverflowMenuId = null;
    renderMessages();
  }
});

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
    // A bare "🕒N" count told you nothing without opening the panel — this
    // shows what's actually scheduled (reusing the same scheduleSummary()
    // text the expanded panel's "Scheduled sends" list already uses),
    // capped at 2 so a message with many schedules doesn't blow up the
    // collapsed row.
    const enabledSchedules = (m.schedules || []).filter((s) => s.enabled);
    const scheduleLine =
      enabledSchedules.length > 0
        ? `<br/><span class="log-time schedule-line" data-tooltip="${escapeHtml(enabledSchedules.map((s) => scheduleSummary(s)).join(', '))}">🕒 ${escapeHtml(
            enabledSchedules
              .slice(0, 2)
              .map((s) => scheduleSummary(s))
              .join(' · ')
          )}${enabledSchedules.length > 2 ? ` +${enabledSchedules.length - 2} more` : ''}</span>`
        : '';
    const autoReplyLine =
      m.autoReply && m.autoReply.enabled && (m.autoReply.triggers || []).some((t) => t.value)
        ? `<br/><span class="log-time schedule-line" data-tooltip="Auto-replies when a message matches: ${escapeHtml(
            (m.autoReply.triggers || [])
              .filter((t) => t.value)
              .map((t) => t.value)
              .join(', ')
          )}">⚡ Auto-reply on</span>`
        : '';
    const isPanelOpen = openSendPanelMessageId === m.id;
    // Quick "send to whatever chat is open right now" — lives on the
    // collapsed card itself (not behind expanding the panel) since it
    // needs no configuration: no list to pick, nothing to schedule.
    const quickSendBtnHtml = activeChatBtnHtml({
      act: 'sendActiveChat',
      title: 'Send to currently open chat — sends only to whatever chat is open right now in the WhatsApp Web tab, no list needed.',
      iconSvg: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
      run: activeChatRunFor(`msg-${m.id}`),
      runKey: `msg-${m.id}`
    });
    li.innerHTML = `<div class="item-row">
      <div class="item-text">
        ${srNoBadge}<b>${escapeHtml(m.name)}</b><br/>${preview}<br/>
        <span class="log-time">${lastSent}</span>${scheduleLine}${autoReplyLine}
      </div>
      <div class="item-actions">
        ${quickSendBtnHtml}
        <button class="icon-btn small-icon-btn chevron-toggle-btn${isPanelOpen ? ' expanded' : ''}" data-act="send" type="button" data-tooltip="Send to lists / schedule">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div class="row-overflow${messageOverflowMenuId === m.id ? ' open' : ''}">
          <div class="row-fan">
            <button class="icon-btn small-icon-btn fan-item" data-act="edit" type="button" data-tooltip="Edit">${EDIT_ICON_SVG}</button>
            <button class="icon-btn small-icon-btn fan-item" data-act="moveUp" type="button" data-tooltip="Move up" ${idx === 0 ? 'disabled' : ''}>${MOVE_UP_ICON_SVG}</button>
            <button class="icon-btn small-icon-btn fan-item" data-act="moveDown" type="button" data-tooltip="Move down" ${idx === sortedMessages.length - 1 ? 'disabled' : ''}>${MOVE_DOWN_ICON_SVG}</button>
            <button class="icon-btn small-icon-btn danger fan-item" data-act="del" type="button" data-tooltip="Delete">${DELETE_ICON_SVG}</button>
          </div>
          <button class="icon-btn small-icon-btn overflow-toggle-btn" data-act="overflow" type="button" data-tooltip="More">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>
          </button>
        </div>
      </div>
    </div>`;

    // Auto-show the panel whenever this message has a tracked run — not
    // just when the user manually toggled it open — so a live send's
    // progress/pause button is visible without having to remember which
    // message you sent and re-click its Send icon to find out.
    if (openSendPanelMessageId === m.id || messageRunIds.has(m.id)) {
      sendPanelRerender = renderMessages; // this mount belongs to the Messages tab, not the Campaigns tab
      li.appendChild(buildSendPanel(m));
    }

    li.querySelector('[data-act="send"]').addEventListener('click', () => {
      if (!STATE.settings.consentAccepted) {
        showToast('Accept the consent checkbox on the Settings tab first — sending is gated behind it, even for a one-off send.', 'error');
        return;
      }
      const opening = openSendPanelMessageId !== m.id;
      if (opening) {
        resetScheduleEditor();
        campaignEditorMessageId = null; // only one schedule editor open at a time, app-wide
        campaignPickerOpen = false;
      }
      setOpenSendPanel(opening ? m.id : null);
      renderMessages();
    });
    const quickSendBtn = li.querySelector('[data-act="sendActiveChat"]');
    if (quickSendBtn) {
      quickSendBtn.addEventListener('click', async () => {
        if (!STATE.settings.consentAccepted) {
          showToast('Accept the consent checkbox on the Settings tab first — sending is gated behind it, even for a one-off send.', 'error');
          return;
        }
        // No panel is necessarily open to read a per-item selection from —
        // this quick action reads the same persisted unchecked-items state
        // the full panel's checklist would show (so excluding an item there
        // sticks even for this shortcut), defaulting to "every item" when
        // nothing's been customized.
        const unchecked = uncheckedSetFor(m.id);
        let itemIndexes;
        if (items.length > 1) {
          itemIndexes = items.map((_, i) => i).filter((i) => !unchecked.has(i));
          if (itemIndexes.length === 0) {
            showToast('Select at least one item to send (open the panel to choose).', 'error');
            return;
          }
        }
        const res = await call('sendNowActiveChat', { messageId: m.id, sendSeparator: sendPanelSeparatorPref, itemIndexes });
        if (res.ok && res.runId) {
          activeChatRunIds.set(`msg-${m.id}`, { runId: res.runId, assignedAt: Date.now() });
          saveActiveChatRunIds();
        } else if (!res.ok) {
          showToast(res.error || 'Could not send to the currently open chat.', 'error');
        }
        renderMessages();
      });
    }
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingMessageId = m.id;
      editingMessageSrNo = typeof m.srNo === 'number' ? m.srNo : null;
      editingThreadItem = null;
      hfPanelItem = null;
      bulkHfPanelOpen = false;
      composingHfMode = m.headerFooterMode || 'default';
      composingHfHeaderText = m.headerText || '';
      composingHfFooterText = m.footerText || '';
      messageHfPanelOpen = false;
      composingAutoReply = m.autoReply || defaultAutoReply();
      messageAutoReplyPanelOpen = false;
      document.getElementById('msgLabel').value = m.name;
      document.getElementById('msgLabelRow').style.display = '';
      const items = m.items || [];
      // A saved message that's just one text thread with no thread-level
      // header/footer override of its own edits like plain text — straight
      // in the box, no thread list to open first. Leaving composingItems
      // empty here (not populated with that one item) is what does it:
      // it's the exact same shape as "typed something, never clicked +"
      // for a brand-new message, so getEffectiveItems() already picks up
      // whatever's currently in the box when you save, no extra wiring
      // needed. A thread-level override wouldn't survive that (a fresh
      // plain-text item has nowhere to carry it), so it keeps the item
      // visible in the list instead, same as multi-thread/mixed messages.
      const singleItem = items.length === 1 ? items[0] : null;
      const singleItemHasOwnHf = singleItem && singleItem.headerFooterMode && singleItem.headerFooterMode !== 'default';
      if (singleItem && singleItem.kind === 'text' && !singleItemHasOwnHf) {
        document.getElementById('msgText').value = singleItem.text;
        composingItems = [];
      } else {
        document.getElementById('msgText').value = '';
        composingItems = items.map((item) => ({ ...item })); // clone so cancel doesn't mutate the saved copy
      }
      renderComposingItems();
      setBtnLabel('saveMessageBtn', 'Update message');
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
    li.querySelector('.row-fan').addEventListener('click', (e) => e.stopPropagation());
    li.querySelector('[data-act="overflow"]').addEventListener('click', (e) => {
      e.stopPropagation();
      messageOverflowMenuId = messageOverflowMenuId === m.id ? null : m.id;
      renderMessages();
    });
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
      ${run.done ? `<button class="ghost small-inline" type="button" data-act="closeSend">${CHECK_ICON_SVG}<span class="btn-label">Close</span></button>` : '<p class="hint">Sending — this updates live.</p>'}
    `;
    const closeBtn = panel.querySelector('[data-act="closeSend"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        messageRunIds.delete(message.id);
        saveMessageRunIds();
        setOpenSendPanel(null);
        sendPanelRerender();
      });
    }
    return panel;
  }

  const items = message.items || [];
  const schedules = message.schedules || [];
  const unchecked = uncheckedSetFor(message.id);
  const scheduleListHtml = schedules.length
    ? `<h3>Scheduled sends</h3>
    <ul class="item-list schedule-list">
      ${schedules
        .map((s) => {
          const scheduleRun = STATE.activeRuns[`${message.id}:${s.id}`];
          return `<li class="schedule-row" data-schedule-id="${s.id}">
            <div class="item-row">
              <div class="item-text">
                ${s.label ? `<b>${escapeHtml(s.label)}</b><br/>` : ''}
                ${escapeHtml(scheduleSummary(s))}<br/>
                <span class="log-time">${s.enabled ? 'enabled' : 'paused'}</span>
              </div>
              <div class="item-actions">
                <button class="icon-btn small-icon-btn" type="button" data-sched-act="edit" data-tooltip="Edit">${EDIT_ICON_SVG}</button>
                <button class="icon-btn small-icon-btn" type="button" data-sched-act="toggle" data-tooltip="${s.enabled ? 'Pause' : 'Resume'}">${s.enabled ? PAUSE_ICON_SVG : PLAY_ICON_SVG}</button>
                <button class="icon-btn small-icon-btn" type="button" data-sched-act="run" data-tooltip="Run now">${RUN_NOW_ICON_SVG}</button>
                <button class="icon-btn small-icon-btn danger" type="button" data-sched-act="del" data-tooltip="Delete">${DELETE_ICON_SVG}</button>
              </div>
            </div>
            ${scheduleRun ? renderProgressBlock(scheduleRun) : ''}
          </li>`;
        })
        .join('')}
    </ul>`
    : '';
  const itemPickerExpanded = expandedItemPickers.has(message.id);
  const selectedCount = items.length - unchecked.size;
  const itemPickerSummaryText =
    selectedCount === items.length ? `All ${items.length} items selected` : `${selectedCount} of ${items.length} items selected`;
  panel.innerHTML = `
    ${
      items.length > 1
        ? `<h3>What to send</h3>
    <button type="button" class="item-picker-summary" data-act="toggleItemPicker">
      <span class="item-picker-summary-text">${itemPickerSummaryText}</span>
      <svg class="chevron-icon${itemPickerExpanded ? ' expanded' : ''}" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </button>
    <div class="composing-list" style="display:${itemPickerExpanded ? '' : 'none'}">
      <div class="send-panel-top-row">
        <label class="checkbox-row send-item-select-all-row">
          <input type="checkbox" class="send-item-select-all" ${unchecked.size === 0 ? 'checked' : ''} ${unchecked.size > 0 && unchecked.size < items.length ? 'data-indeterminate="1"' : ''} />
          Select all
        </label>
      </div>
      ${items
        .map((item, idx) => {
          const icon = item.kind === 'media' ? '📎' : '📝';
          const preview = item.kind === 'media' ? escapeHtml(item.media.filename) : escapeHtml((item.text || '').slice(0, 60));
          return `<div class="composing-item">
            <input type="checkbox" class="send-item-select" data-idx="${idx}" ${unchecked.has(idx) ? '' : 'checked'} />
            <span class="composing-item-icon">${icon}</span>
            <div class="composing-item-body">
              <div class="composing-item-preview">${preview}</div>
            </div>
            <div class="composing-item-actions">
              ${
                item.kind === 'media'
                  ? `<button class="icon-btn small-icon-btn" type="button" data-act="openItemTab" data-idx="${idx}" data-tooltip="Open this file in a new tab">
                <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </button>`
                  : ''
              }
              ${activeChatBtnHtml({
                act: 'sendItemActiveChat',
                idx,
                title: 'Send only this item to the currently open chat',
                iconSvg: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
                run: activeChatRunFor(`msg-${message.id}:${idx}`),
                runKey: `msg-${message.id}:${idx}`
              })}
            </div>
          </div>`;
        })
        .join('')}
    </div>`
        : ''
    }
    <h3>Send</h3>
    ${
      STATE.lists.length === 0
        ? '<p class="hint">Build a list first (Lists tab) to send to more than one chat, or to schedule a send.</p>'
        : `
    <div class="checklist">
      ${STATE.lists
        .map((l) => {
          const members = l.members || [];
          const selected = listSelectionSetFor(message.id, l.id);
          const selectedCount = members.filter((m) => selected.has(m.waId)).length;
          const expandKey = `${message.id}:${l.id}`;
          const expanded = expandedListPanels.has(expandKey);
          return `<div class="list-check-row">
            <label class="checkbox-row list-check-label">
              <input type="checkbox" class="send-list-check" value="${l.id}" ${selectedCount === members.length && members.length > 0 ? 'checked' : ''} ${selectedCount > 0 && selectedCount < members.length ? 'data-indeterminate="1"' : ''} />
              ${escapeHtml(l.name)} <span class="muted badge-count-${l.id}">(${selectedCount}/${members.length})</span>
            </label>
            ${
              members.length > 0
                ? `<button class="icon-btn small-icon-btn list-expand-btn" type="button" data-act="toggleListMembers" data-list-id="${l.id}" data-tooltip="Choose which chats in this list">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
            </button>`
                : ''
            }
          </div>
          ${
            members.length > 0
              ? `<div class="list-members" data-list-id="${l.id}" style="display:${expanded ? '' : 'none'}">
            ${members
              .map(
                (m) =>
                  `<label class="checkbox-row list-member-row"><input type="checkbox" class="list-member-check" data-list-id="${l.id}" data-wa-id="${escapeHtml(m.waId)}" ${selected.has(m.waId) ? 'checked' : ''} /> ${escapeHtml(m.name || m.waId)}</label>`
              )
              .join('')}
          </div>`
              : ''
          }`;
        })
        .join('')}
    </div>
    ${scheduleListHtml}
    <div class="kind-toggle send-panel-mode-toggle">
      <button type="button" class="kind-btn send-mode-btn ${sendPanelMode === 'send' ? 'active' : ''}" data-mode="send">Now</button>
      <button type="button" class="kind-btn send-mode-btn ${sendPanelMode === 'schedule' ? 'active' : ''}" data-mode="schedule">Schedule</button>
    </div>
    <div class="send-panel-actions" style="display:${sendPanelMode === 'send' ? '' : 'none'}">
      <label class="checkbox-row send-separator-check-row">
        <input type="checkbox" class="send-separator-check" ${sendPanelSeparatorPref ? 'checked' : ''} />
        Send a "➖" separator after each item
      </label>
      <button class="primary" type="button" data-act="confirmSend">${SEND_ICON_SVG}<span class="btn-label">Send now</span></button>
      <button class="ghost small-inline" type="button" data-act="cancelSend">${CLOSE_ICON_SVG}<span class="btn-label">Cancel</span></button>
    </div>
    <div class="schedule-editor" style="display:${sendPanelMode === 'schedule' ? '' : 'none'}">
      <label>When</label>
      <div class="kind-toggle schedule-type-toggle">
        <button type="button" class="kind-btn ${scheduleType === 'times' ? 'active' : ''}" data-schedule-type="times">Daily time(s)</button>
        <button type="button" class="kind-btn ${scheduleType === 'interval' ? 'active' : ''}" data-schedule-type="interval">Repeat interval</button>
        <button type="button" class="kind-btn ${scheduleType === 'once' ? 'active' : ''}" data-schedule-type="once">Specific date(s)</button>
      </div>

      <div class="schedule-times-panel" style="display:${scheduleType === 'times' ? '' : 'none'}">
        <p class="hint">Repeats every day, forever, at each time you add — e.g. add 9:00 AM and 6:00 PM to run twice daily.</p>
        <div class="when-row">
          <input type="time" class="schedule-time-input" value="09:00" />
          <button type="button" class="small schedule-add-time-btn"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>Add time</button>
        </div>
        <div class="chip-list schedule-times-list"></div>
      </div>

      <div class="schedule-interval-panel" style="display:${scheduleType === 'interval' ? '' : 'none'}">
        <label>Repeat every</label>
        <div class="when-row">
          <input type="number" min="1" value="1" class="schedule-interval-value" />
          <select class="schedule-interval-unit">
            <option value="minutes">Minutes</option>
            <option value="hours" selected>Hours</option>
          </select>
        </div>
        <label>Or: times per day instead (overrides "Repeat every" above)</label>
        <p class="hint">Say how many runs you want today and the spacing is worked out for you — e.g. 5 times a day = one run roughly every 4h48m, evenly spread out.</p>
        <input type="number" min="0" placeholder="e.g. 5 — leave blank to use the interval above" class="schedule-times-per-day" />
        <label>Active hours (optional)</label>
        <p class="hint">Without this, the interval above runs around the clock, including overnight. Set a window to keep runs inside business hours — a tick outside it is silently skipped, not sent late.</p>
        <div class="when-row">
          <input type="time" class="schedule-window-start" /> to
          <input type="time" class="schedule-window-end" />
        </div>
      </div>

      <div class="schedule-once-panel" style="display:${scheduleType === 'once' ? '' : 'none'}">
        <p class="hint">Each date/time you add fires exactly once, then it's done — nothing repeats. Add several for a handful of one-off runs on this schedule without recreating it each time.</p>
        <div class="when-row">
          <input type="datetime-local" class="schedule-datetime-input" />
          <button type="button" class="small schedule-add-datetime-btn"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>Add</button>
        </div>
        <div class="chip-list schedule-datetimes-list"></div>
      </div>

      <button type="button" class="advanced-toggle-btn" data-act="toggleScheduleAdvanced">
        <svg class="chevron-icon${scheduleAdvancedOpen ? ' expanded' : ''}" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        Advanced (delay, label)
      </button>
      <div class="schedule-advanced-fields" style="display:${scheduleAdvancedOpen ? '' : 'none'}">
        <label class="checkbox-row">
          <input type="checkbox" class="schedule-use-default-delay" checked />
          Use default delay from Safety settings
        </label>
        <label>Delay between messages (seconds)</label>
        <div class="when-row">
          <input type="number" min="1" max="300" class="schedule-delay-min" disabled /> to
          <input type="number" min="1" max="300" class="schedule-delay-max" disabled />
        </div>
        <label>Delay before starting the next list (seconds)</label>
        <div class="when-row">
          <input type="number" min="1" max="600" class="schedule-list-delay-min" disabled /> to
          <input type="number" min="1" max="600" class="schedule-list-delay-max" disabled />
        </div>
        <label>Schedule label (optional — only useful with more than one schedule on this message)</label>
        <input type="text" class="schedule-label-input" placeholder="e.g. Monday reminder" />
      </div>
      <label class="checkbox-row send-separator-check-row">
        <input type="checkbox" class="schedule-separator-check" ${scheduleSeparatorPref ? 'checked' : ''} />
        Send a "➖" separator after each item
      </label>
      <button class="primary" type="button" data-act="confirmSchedule">${CHECK_ICON_SVG}<span class="btn-label">${editingScheduleId ? 'Update schedule' : 'Save schedule'}</span></button>
      <button class="ghost small-inline" type="button" data-act="cancelSchedule">${CLOSE_ICON_SVG}<span class="btn-label">Cancel</span></button>
    </div>
    `
    }
  `;
  function closeSendPanel() {
    messageRunIds.delete(message.id);
    saveMessageRunIds();
    resetScheduleEditor();
    setOpenSendPanel(null);
    sendPanelRerender();
  }
  const cancelBtn = panel.querySelector('[data-act="cancelSend"]');
  if (cancelBtn) cancelBtn.addEventListener('click', closeSendPanel);
  const cancelScheduleBtn = panel.querySelector('[data-act="cancelSchedule"]');
  if (cancelScheduleBtn) cancelScheduleBtn.addEventListener('click', closeSendPanel);
  const separatorCheck = panel.querySelector('.send-separator-check');
  if (separatorCheck) {
    separatorCheck.addEventListener('change', () => {
      sendPanelSeparatorPref = separatorCheck.checked;
      chrome.storage.local.set({ sendPanelSeparatorPref });
    });
  }

  // ---- schedule editor: mode toggle, "when" sub-toggle, chips, prefill ----
  panel.querySelectorAll('.send-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === 'schedule' && sendPanelMode !== 'schedule') {
        // Entering the Schedule tab fresh (not via the pencil on a specific
        // existing schedule below) always starts a new-schedule draft.
        editingScheduleId = null;
        scheduleType = 'times';
        scheduleTimes = [];
        scheduleDatetimes = [];
      }
      sendPanelMode = btn.dataset.mode;
      sendPanelRerender();
    });
  });
  function setScheduleType(type) {
    scheduleType = type;
    panel.querySelectorAll('.schedule-type-toggle .kind-btn').forEach((b) => b.classList.toggle('active', b.dataset.scheduleType === type));
    const timesPanel = panel.querySelector('.schedule-times-panel');
    const intervalPanel = panel.querySelector('.schedule-interval-panel');
    const oncePanel = panel.querySelector('.schedule-once-panel');
    if (timesPanel) timesPanel.style.display = type === 'times' ? '' : 'none';
    if (intervalPanel) intervalPanel.style.display = type === 'interval' ? '' : 'none';
    if (oncePanel) oncePanel.style.display = type === 'once' ? '' : 'none';
  }
  panel.querySelectorAll('.schedule-type-toggle .kind-btn').forEach((btn) => {
    btn.addEventListener('click', () => setScheduleType(btn.dataset.scheduleType));
  });
  function renderScheduleTimesChips() {
    const box = panel.querySelector('.schedule-times-list');
    if (!box) return;
    box.innerHTML = scheduleTimes.length
      ? scheduleTimes.map((t, i) => `<span class="chip">${escapeHtml(t)}<button type="button" data-idx="${i}">✕</button></span>`).join('')
      : '<span class="hint">No times added yet.</span>';
    box.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        scheduleTimes.splice(Number(btn.dataset.idx), 1);
        renderScheduleTimesChips();
      });
    });
  }
  renderScheduleTimesChips();
  function addScheduleTime() {
    const input = panel.querySelector('.schedule-time-input');
    if (!input.value || scheduleTimes.includes(input.value)) return;
    scheduleTimes.push(input.value);
    scheduleTimes.sort();
    renderScheduleTimesChips();
  }
  const addTimeBtn = panel.querySelector('.schedule-add-time-btn');
  if (addTimeBtn) addTimeBtn.addEventListener('click', addScheduleTime);
  const scheduleTimeInput = panel.querySelector('.schedule-time-input');
  if (scheduleTimeInput) {
    scheduleTimeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addScheduleTime();
      }
    });
  }
  function renderScheduleDatetimesChips() {
    const box = panel.querySelector('.schedule-datetimes-list');
    if (!box) return;
    box.innerHTML = scheduleDatetimes.length
      ? scheduleDatetimes
          .map((dt, i) => `<span class="chip">${escapeHtml(new Date(dt).toLocaleString())}<button type="button" data-idx="${i}">✕</button></span>`)
          .join('')
      : '<span class="hint">No dates added yet.</span>';
    box.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        scheduleDatetimes.splice(Number(btn.dataset.idx), 1);
        renderScheduleDatetimesChips();
      });
    });
  }
  renderScheduleDatetimesChips();
  function addScheduleDatetime() {
    const input = panel.querySelector('.schedule-datetime-input');
    if (!input.value) return;
    scheduleDatetimes.push(input.value);
    scheduleDatetimes.sort();
    renderScheduleDatetimesChips();
  }
  const addDatetimeBtn = panel.querySelector('.schedule-add-datetime-btn');
  if (addDatetimeBtn) addDatetimeBtn.addEventListener('click', addScheduleDatetime);
  const scheduleDatetimeInput = panel.querySelector('.schedule-datetime-input');
  if (scheduleDatetimeInput) {
    scheduleDatetimeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addScheduleDatetime();
      }
    });
  }
  const advancedToggleBtn = panel.querySelector('[data-act="toggleScheduleAdvanced"]');
  if (advancedToggleBtn) {
    advancedToggleBtn.addEventListener('click', () => {
      scheduleAdvancedOpen = !scheduleAdvancedOpen;
      const fields = panel.querySelector('.schedule-advanced-fields');
      if (fields) fields.style.display = scheduleAdvancedOpen ? '' : 'none';
      const chevron = advancedToggleBtn.querySelector('.chevron-icon');
      if (chevron) chevron.classList.toggle('expanded', scheduleAdvancedOpen);
    });
  }
  function setScheduleDelayFieldsDisabled(disabled) {
    ['.schedule-delay-min', '.schedule-delay-max', '.schedule-list-delay-min', '.schedule-list-delay-max'].forEach((sel) => {
      const el = panel.querySelector(sel);
      if (el) el.disabled = disabled;
    });
  }
  const useDefaultDelayCb = panel.querySelector('.schedule-use-default-delay');
  if (useDefaultDelayCb) {
    useDefaultDelayCb.addEventListener('change', () => setScheduleDelayFieldsDisabled(useDefaultDelayCb.checked));
  }
  const scheduleSeparatorCheck = panel.querySelector('.schedule-separator-check');
  if (scheduleSeparatorCheck) {
    scheduleSeparatorCheck.addEventListener('change', () => {
      scheduleSeparatorPref = scheduleSeparatorCheck.checked;
      chrome.storage.local.set({ scheduleSeparatorPref });
    });
  }
  if (sendPanelMode === 'schedule') {
    const editingSchedule = editingScheduleId ? schedules.find((s) => s.id === editingScheduleId) : null;
    const setVal = (sel, v) => {
      const el = panel.querySelector(sel);
      if (el) el.value = v;
    };
    setVal('.schedule-label-input', editingSchedule ? editingSchedule.label || '' : '');
    const useDefaultDelay = editingSchedule ? editingSchedule.useDefaultDelay !== false : true;
    if (useDefaultDelayCb) useDefaultDelayCb.checked = useDefaultDelay;
    setScheduleDelayFieldsDisabled(useDefaultDelay);
    const [dMin, dMax] = (editingSchedule && editingSchedule.delayBetweenMsMs) || STATE.settings.defaultDelayBetweenMsMs || [20000, 45000];
    const [lMin, lMax] = (editingSchedule && editingSchedule.delayBetweenListsMs) || STATE.settings.defaultDelayBetweenListsMs || [30000, 60000];
    setVal('.schedule-delay-min', Math.round(dMin / 1000));
    setVal('.schedule-delay-max', Math.round(dMax / 1000));
    setVal('.schedule-list-delay-min', Math.round(lMin / 1000));
    setVal('.schedule-list-delay-max', Math.round(lMax / 1000));
    if (scheduleSeparatorCheck) scheduleSeparatorCheck.checked = editingSchedule ? editingSchedule.sendSeparator !== false : scheduleSeparatorPref;
    if (scheduleType === 'interval') {
      const minutes = (editingSchedule && editingSchedule.intervalMinutes) || 60;
      if (minutes % 60 === 0) {
        setVal('.schedule-interval-value', minutes / 60);
        setVal('.schedule-interval-unit', 'hours');
      } else {
        setVal('.schedule-interval-value', minutes);
        setVal('.schedule-interval-unit', 'minutes');
      }
      setVal('.schedule-window-start', (editingSchedule && editingSchedule.windowStart) || '');
      setVal('.schedule-window-end', (editingSchedule && editingSchedule.windowEnd) || '');
    }
    // Editing an existing schedule loads its target list(s) into the same
    // shared per-message selection the checklist above (and "Send now")
    // reads from — same pattern as editing a message loading its content
    // into the one shared composer, overwriting whatever was there before.
    if (editingSchedule) {
      const byList = new Map();
      for (const listId of editingSchedule.listIds || []) {
        const list = STATE.lists.find((l) => l.id === listId);
        if (!list) continue;
        const allowed = editingSchedule.memberFilter && editingSchedule.memberFilter[listId];
        const waIds = allowed || (list.members || []).map((m) => m.waId);
        byList.set(listId, new Set(waIds));
      }
      listSelections.set(message.id, byList);
      saveListSelections();
    }
  }
  panel.querySelectorAll('[data-sched-act="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scheduleId = btn.closest('[data-schedule-id]').dataset.scheduleId;
      const schedule = schedules.find((s) => s.id === scheduleId);
      if (schedule) startEditingSchedule(schedule);
      sendPanelRerender();
    });
  });
  panel.querySelectorAll('[data-sched-act="toggle"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scheduleId = btn.closest('[data-schedule-id]').dataset.scheduleId;
      const schedule = schedules.find((s) => s.id === scheduleId);
      if (!schedule) return;
      await call('toggleSchedule', { messageId: message.id, scheduleId, enabled: !schedule.enabled });
      refresh();
    });
  });
  panel.querySelectorAll('[data-sched-act="run"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scheduleId = btn.closest('[data-schedule-id]').dataset.scheduleId;
      await call('runScheduleNow', { messageId: message.id, scheduleId });
      setTimeout(refresh, 1500);
    });
  });
  panel.querySelectorAll('[data-sched-act="del"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scheduleId = btn.closest('[data-schedule-id]').dataset.scheduleId;
      const schedule = schedules.find((s) => s.id === scheduleId);
      const label = schedule && schedule.label ? schedule.label : scheduleSummary(schedule);
      if (!(await showConfirmDialog(`Delete schedule "${label}"?`, { confirmText: 'Delete', danger: true }))) return;
      await call('deleteSchedule', { messageId: message.id, scheduleId });
      if (editingScheduleId === scheduleId) resetScheduleEditor();
      refresh();
    });
  });
  const confirmScheduleBtn = panel.querySelector('[data-act="confirmSchedule"]');
  if (confirmScheduleBtn) {
    confirmScheduleBtn.addEventListener('click', async () => {
      const memberFilter = {};
      const listIds = [];
      for (const l of STATE.lists) {
        const members = l.members || [];
        if (members.length === 0) continue;
        const selected = listSelectionSetFor(message.id, l.id);
        const selectedWaIds = members.filter((m) => selected.has(m.waId)).map((m) => m.waId);
        if (selectedWaIds.length === 0) continue;
        listIds.push(l.id);
        if (selectedWaIds.length < members.length) memberFilter[l.id] = selectedWaIds;
      }
      if (listIds.length === 0) {
        showToast('Select at least one chat to send to.', 'error');
        return;
      }
      const itemChecks = panel.querySelectorAll('.send-item-select');
      let itemIndexes;
      if (itemChecks.length > 0) {
        itemIndexes = Array.from(itemChecks)
          .filter((cb) => cb.checked)
          .map((cb) => Number(cb.dataset.idx));
        if (itemIndexes.length === 0) {
          showToast('Select at least one item to send.', 'error');
          return;
        }
      }
      const useDefaultDelay = panel.querySelector('.schedule-use-default-delay').checked;
      const sendSeparator = panel.querySelector('.schedule-separator-check').checked;
      const label = panel.querySelector('.schedule-label-input').value.trim();
      const schedule = {
        id: editingScheduleId,
        label,
        listIds,
        memberFilter,
        itemIndexes,
        scheduleType,
        enabled: true,
        useDefaultDelay,
        sendSeparator,
        delayBetweenMsMs: [
          secToMs(panel.querySelector('.schedule-delay-min').value, 20000),
          secToMs(panel.querySelector('.schedule-delay-max').value, 45000)
        ],
        delayBetweenListsMs: [
          secToMs(panel.querySelector('.schedule-list-delay-min').value, 30000),
          secToMs(panel.querySelector('.schedule-list-delay-max').value, 60000)
        ]
      };
      if (scheduleType === 'times') {
        if (scheduleTimes.length === 0) {
          showToast('Add at least one daily time.', 'error');
          return;
        }
        schedule.times = scheduleTimes.slice();
      } else if (scheduleType === 'interval') {
        const timesPerDay = Number(panel.querySelector('.schedule-times-per-day').value);
        if (timesPerDay > 0) {
          schedule.intervalMinutes = Math.round(1440 / timesPerDay);
        } else {
          const value = Number(panel.querySelector('.schedule-interval-value').value) || 1;
          const unit = panel.querySelector('.schedule-interval-unit').value;
          schedule.intervalMinutes = unit === 'hours' ? value * 60 : value;
        }
        schedule.windowStart = panel.querySelector('.schedule-window-start').value || null;
        schedule.windowEnd = panel.querySelector('.schedule-window-end').value || null;
      } else if (scheduleType === 'once') {
        if (scheduleDatetimes.length === 0) {
          showToast('Add at least one date/time.', 'error');
          return;
        }
        schedule.datetimes = scheduleDatetimes.slice();
      }
      const res = await call('saveSchedule', { messageId: message.id, schedule });
      if (!res.ok) {
        showToast(res.error || 'Could not save schedule.', 'error');
        return;
      }
      resetScheduleEditor();
      // refresh(), not renderMessages() — the schedule was just written to
      // storage, and STATE here is still the pre-save copy. Every other
      // schedule mutation (toggle/run/delete, below) already does this;
      // this was the one spot still re-rendering stale data, which is why
      // a just-saved schedule's badge/list wouldn't show up right away.
      refresh();
    });
  }
  panel.querySelectorAll('[data-act="toggleListMembers"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const listId = btn.dataset.listId;
      const key = `${message.id}:${listId}`;
      const membersEl = panel.querySelector(`.list-members[data-list-id="${listId}"]`);
      const nowExpanded = membersEl.style.display === 'none';
      membersEl.style.display = nowExpanded ? '' : 'none';
      btn.classList.toggle('expanded', nowExpanded);
      if (nowExpanded) expandedListPanels.add(key);
      else expandedListPanels.delete(key);
    });
  });
  function updateListCheckboxState(listId) {
    const list = STATE.lists.find((l) => l.id === listId);
    if (!list) return;
    const members = list.members || [];
    const selected = listSelectionSetFor(message.id, listId);
    const selectedCount = members.filter((m) => selected.has(m.waId)).length;
    const badge = panel.querySelector(`.badge-count-${listId}`);
    if (badge) badge.textContent = `(${selectedCount}/${members.length})`;
    const listCb = panel.querySelector(`.send-list-check[value="${listId}"]`);
    if (listCb) {
      listCb.checked = selectedCount > 0 && selectedCount === members.length;
      listCb.indeterminate = selectedCount > 0 && selectedCount < members.length;
    }
  }
  panel.querySelectorAll('.send-list-check').forEach((cb) => {
    cb.indeterminate = cb.hasAttribute('data-indeterminate');
  });
  panel.querySelectorAll('.list-member-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const listId = cb.dataset.listId;
      const selected = listSelectionSetFor(message.id, listId);
      if (cb.checked) selected.add(cb.dataset.waId);
      else selected.delete(cb.dataset.waId);
      saveListSelections();
      updateListCheckboxState(listId);
    });
  });
  // The list's own checkbox doubles as select-all/none for its members —
  // there's no separate select-all row inside the expanded member list.
  // Selecting the list itself, or selecting just some chats within it
  // (without ever touching the list checkbox), both count as "this list is
  // part of the send" — see confirmSend below, which reads member
  // selections directly rather than gating on the list checkbox alone.
  panel.querySelectorAll('.send-list-check').forEach((listCb) => {
    listCb.addEventListener('change', () => {
      const listId = listCb.value;
      const memberChecks = panel.querySelectorAll(`.list-member-check[data-list-id="${listId}"]`);
      const selected = listSelectionSetFor(message.id, listId);
      memberChecks.forEach((cb) => {
        cb.checked = listCb.checked;
        if (listCb.checked) selected.add(cb.dataset.waId);
        else selected.delete(cb.dataset.waId);
      });
      saveListSelections();
      updateListCheckboxState(listId);
    });
  });
  const itemPickerToggleBtn = panel.querySelector('[data-act="toggleItemPicker"]');
  if (itemPickerToggleBtn) {
    itemPickerToggleBtn.addEventListener('click', () => {
      const nowExpanded = !expandedItemPickers.has(message.id);
      if (nowExpanded) expandedItemPickers.add(message.id);
      else expandedItemPickers.delete(message.id);
      const list = panel.querySelector('.composing-list');
      if (list) list.style.display = nowExpanded ? '' : 'none';
      const chevron = itemPickerToggleBtn.querySelector('.chevron-icon');
      if (chevron) chevron.classList.toggle('expanded', nowExpanded);
    });
  }
  function updateItemPickerSummary() {
    const summaryText = panel.querySelector('.item-picker-summary-text');
    if (!summaryText) return;
    const selected = items.length - unchecked.size;
    summaryText.textContent = selected === items.length ? `All ${items.length} items selected` : `${selected} of ${items.length} items selected`;
  }
  const selectAllCheck = panel.querySelector('.send-item-select-all');
  const itemSelectChecks = panel.querySelectorAll('.send-item-select');
  if (selectAllCheck) {
    selectAllCheck.indeterminate = selectAllCheck.hasAttribute('data-indeterminate');
    selectAllCheck.addEventListener('change', () => {
      itemSelectChecks.forEach((cb) => {
        cb.checked = selectAllCheck.checked;
        if (selectAllCheck.checked) unchecked.delete(Number(cb.dataset.idx));
        else unchecked.add(Number(cb.dataset.idx));
      });
      updateItemPickerSummary();
    });
    itemSelectChecks.forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) unchecked.delete(Number(cb.dataset.idx));
        else unchecked.add(Number(cb.dataset.idx));
        const checks = Array.from(itemSelectChecks);
        const allChecked = checks.every((c) => c.checked);
        const noneChecked = checks.every((c) => !c.checked);
        selectAllCheck.checked = allChecked;
        selectAllCheck.indeterminate = !allChecked && !noneChecked;
        updateItemPickerSummary();
      });
    });
  }
  const confirmBtn = panel.querySelector('[data-act="confirmSend"]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      // A list counts as "picked" as soon as it has at least one selected
      // chat — whether that came from checking the list itself (selects
      // everyone) or hand-picking individual chats within it. Read straight
      // from the selection state rather than the checkbox's own :checked,
      // since a partially-selected list shows as indeterminate (unchecked).
      const memberFilter = {};
      const listIds = [];
      for (const l of STATE.lists) {
        const members = l.members || [];
        if (members.length === 0) continue;
        const selected = listSelectionSetFor(message.id, l.id);
        const selectedWaIds = members.filter((m) => selected.has(m.waId)).map((m) => m.waId);
        if (selectedWaIds.length === 0) continue;
        listIds.push(l.id);
        if (selectedWaIds.length < members.length) memberFilter[l.id] = selectedWaIds;
      }
      if (listIds.length === 0) {
        showToast('Select at least one chat to send to.', 'error');
        return;
      }
      const itemChecks = panel.querySelectorAll('.send-item-select');
      let itemIndexes;
      if (itemChecks.length > 0) {
        itemIndexes = Array.from(itemChecks)
          .filter((cb) => cb.checked)
          .map((cb) => Number(cb.dataset.idx));
        if (itemIndexes.length === 0) {
          showToast('Select at least one item to send.', 'error');
          return;
        }
      }
      const sendSeparator = panel.querySelector('.send-separator-check').checked;
      const res = await call('sendNow', { messageId: message.id, listIds, memberFilter, itemIndexes, sendSeparator });
      if (res.ok && res.runId) {
        messageRunIds.set(message.id, { runId: res.runId, assignedAt: Date.now() });
        saveMessageRunIds();
      }
      sendPanelRerender();
    });
  }
  // The whole-message "send to currently open chat" button used to live
  // here too, but now lives on the collapsed card itself (see
  // renderMessages()) — no config needed for it, so it doesn't need the
  // panel open. Per-item quick-sends below are unaffected.
  panel.querySelectorAll('[data-act="sendItemActiveChat"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemIndex = Number(btn.dataset.idx);
      const res = await call('sendItemToActiveChat', { messageId: message.id, itemIndex });
      if (res.ok && res.runId) {
        activeChatRunIds.set(`msg-${message.id}:${itemIndex}`, { runId: res.runId, assignedAt: Date.now() });
        saveActiveChatRunIds();
      } else if (!res.ok) {
        showToast(res.error || 'Could not send that item to the currently open chat.', 'error');
      }
      sendPanelRerender();
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

// ============ CAMPAIGNS ============
// A view over the schedules that already live on each message
// (message.schedules[]) — not a separate saved entity. "New campaign"
// mounts the exact same buildSendPanel() schedule editor the Messages tab
// uses, just pointed at whichever message is picked here; a campaign
// created/edited from this tab is the same object you'd see in that
// message's own Send panel, not a copy.
let campaignPickerOpen = false;

function renderCampaignsTab() {
  const select = document.getElementById('campaignMessageSelect');
  const picker = document.getElementById('campaignPicker');
  const editorContainer = document.getElementById('campaignEditorContainer');
  const toggleBtn = document.getElementById('campaignNewToggleBtn');
  const sortedMessages = sortMessagesBySrNo(STATE.messages);

  select.innerHTML =
    '<option value="">Choose a saved message…</option>' +
    sortedMessages.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');

  let message = campaignEditorMessageId ? STATE.messages.find((m) => m.id === campaignEditorMessageId) : null;
  if (campaignEditorMessageId && !message) campaignEditorMessageId = null; // deleted elsewhere while this was open

  picker.style.display = campaignPickerOpen && !message ? '' : 'none';
  toggleBtn.classList.toggle('open', campaignPickerOpen || !!message);
  toggleBtn.dataset.tooltip = message || campaignPickerOpen ? 'Cancel' : 'Schedule a saved message';

  editorContainer.innerHTML = '';
  if (message) {
    sendPanelRerender = renderCampaignsTab; // this mount belongs to the Campaigns tab, not Messages
    editorContainer.appendChild(buildSendPanel(message));
  }

  renderCampaignsList(sortedMessages);
}

function renderCampaignsList(sortedMessages) {
  const container = document.getElementById('campaignsList');
  const withSchedules = sortedMessages.filter((m) => (m.schedules || []).length > 0);
  if (withSchedules.length === 0) {
    container.innerHTML =
      '<p class="hint">No campaigns yet — schedule a message above, or from that message\'s own Send panel in the Messages tab.</p>';
    return;
  }
  container.innerHTML = withSchedules
    .map((m) => {
      const rows = (m.schedules || [])
        .map((s) => {
          const scheduleRun = STATE.activeRuns[`${m.id}:${s.id}`];
          return `<li class="schedule-row" data-message-id="${m.id}" data-schedule-id="${s.id}">
            <div class="item-row">
              <div class="item-text">
                ${s.label ? `<b>${escapeHtml(s.label)}</b><br/>` : ''}
                ${escapeHtml(scheduleSummary(s))}<br/>
                <span class="log-time">${s.enabled ? 'enabled' : 'paused'}</span>
              </div>
              <div class="item-actions">
                <button class="icon-btn small-icon-btn" type="button" data-camp-act="edit" data-tooltip="Edit">${EDIT_ICON_SVG}</button>
                <button class="icon-btn small-icon-btn" type="button" data-camp-act="toggle" data-tooltip="${s.enabled ? 'Pause' : 'Resume'}">${s.enabled ? PAUSE_ICON_SVG : PLAY_ICON_SVG}</button>
                <button class="icon-btn small-icon-btn" type="button" data-camp-act="run" data-tooltip="Run now">${RUN_NOW_ICON_SVG}</button>
                <button class="icon-btn small-icon-btn danger" type="button" data-camp-act="del" data-tooltip="Delete">${DELETE_ICON_SVG}</button>
              </div>
            </div>
            ${scheduleRun ? renderProgressBlock(scheduleRun) : ''}
          </li>`;
        })
        .join('');
      return `<div class="panel-card">
        <h3>${escapeHtml(m.name)}</h3>
        <ul class="item-list schedule-list">${rows}</ul>
      </div>`;
    })
    .join('');

  function findRowTarget(btn) {
    const row = btn.closest('[data-schedule-id]');
    const message = STATE.messages.find((mm) => mm.id === row.dataset.messageId);
    const schedule = message && (message.schedules || []).find((s) => s.id === row.dataset.scheduleId);
    return { messageId: row.dataset.messageId, scheduleId: row.dataset.scheduleId, message, schedule };
  }

  container.querySelectorAll('[data-camp-act="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { message, schedule } = findRowTarget(btn);
      if (!message || !schedule) return;
      setOpenSendPanel(null); // only one schedule editor open at a time app-wide
      campaignPickerOpen = false;
      campaignEditorMessageId = message.id;
      startEditingSchedule(schedule);
      renderCampaignsTab();
      document.getElementById('campaignEditorContainer').scrollIntoView({ block: 'nearest' });
    });
  });
  container.querySelectorAll('[data-camp-act="toggle"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { messageId, scheduleId, schedule } = findRowTarget(btn);
      if (!schedule) return;
      await call('toggleSchedule', { messageId, scheduleId, enabled: !schedule.enabled });
      refresh();
    });
  });
  container.querySelectorAll('[data-camp-act="run"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { messageId, scheduleId } = findRowTarget(btn);
      await call('runScheduleNow', { messageId, scheduleId });
      setTimeout(refresh, 1500);
    });
  });
  container.querySelectorAll('[data-camp-act="del"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { messageId, scheduleId, schedule } = findRowTarget(btn);
      const label = schedule && schedule.label ? schedule.label : scheduleSummary(schedule);
      if (!(await showConfirmDialog(`Delete campaign "${label}"?`, { confirmText: 'Delete', danger: true }))) return;
      await call('deleteSchedule', { messageId, scheduleId });
      if (campaignEditorMessageId === messageId && editingScheduleId === scheduleId) resetScheduleEditor();
      refresh();
    });
  });
}

document.getElementById('campaignNewToggleBtn').addEventListener('click', () => {
  if (campaignEditorMessageId) {
    campaignEditorMessageId = null;
    resetScheduleEditor();
  } else {
    campaignPickerOpen = !campaignPickerOpen;
    if (!campaignPickerOpen) document.getElementById('campaignMessageSelect').value = '';
  }
  renderCampaignsTab();
});

// ============ AUTO-REPLY TAB ============
// A view over the same message.autoReply that already lives on each saved
// message (see the bolt-icon panel in the Messages tab compose form) — one
// place to see every message's auto-reply setup and trigger list at a
// glance instead of opening each message individually. Only one row's
// editor is open at a time, same convention as the send/schedule panels.
let autoReplyOpenMessageId = null;
const autoReplySaveTimers = {};

// Debounced so typing a trigger phrase doesn't fire a saveMessage round
// trip on every keystroke — structural changes (toggle/add/remove) call
// this too, but those are already discrete clicks, not keystroke bursts,
// so the debounce is harmless there.
function scheduleAutoReplySave(messageId, ar) {
  clearTimeout(autoReplySaveTimers[messageId]);
  autoReplySaveTimers[messageId] = setTimeout(async () => {
    const message = STATE.messages.find((m) => m.id === messageId);
    if (!message) return;
    await call('saveMessage', { message: { ...message, autoReply: ar } });
    const idx = STATE.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) STATE.messages[idx] = { ...STATE.messages[idx], autoReply: ar };
    renderMessages(); // picks up the "⚡ Auto-reply on" badge without a full refresh()
  }, 500);
}

function renderAutoReplyTab() {
  const container = document.getElementById('autoReplyList');
  if (!container) return;
  const sortedMessages = sortMessagesBySrNo(STATE.messages);
  if (sortedMessages.length === 0) {
    container.innerHTML = '<p class="hint">Save a message on the Messages tab first, then come back here to set up auto-reply for it.</p>';
    return;
  }
  container.innerHTML = `<ul class="item-list">${sortedMessages
    .map((m) => {
      const ar = m.autoReply || defaultAutoReply();
      const isOpen = autoReplyOpenMessageId === m.id;
      const activeTriggers = (ar.triggers || []).filter((t) => t.value);
      const statusLine = !ar.enabled
        ? '<span class="log-time">Auto-reply off</span>'
        : activeTriggers.length === 0
          ? '<span class="log-time">On, but no triggers set yet</span>'
          : `<span class="log-time" data-tooltip="${escapeHtml(activeTriggers.map((t) => t.value).join(', '))}">Triggers: ${escapeHtml(
              activeTriggers
                .slice(0, 3)
                .map((t) => t.value)
                .join(', ')
            )}${activeTriggers.length > 3 ? ` +${activeTriggers.length - 3} more` : ''}</span>`;
      return `<li class="ar-row" data-message-id="${m.id}">
        <div class="item-row">
          <div class="item-text">
            <b>${escapeHtml(m.name)}</b><br/>
            ${statusLine}
          </div>
          <div class="item-actions">
            <span class="hf-mode-badge${ar.enabled ? ' custom' : ''}">${ar.enabled ? 'ON' : 'OFF'}</span>
            <button class="icon-btn small-icon-btn ar-tab-toggle" type="button" data-tooltip="${isOpen ? 'Close' : 'Edit'}">${EDIT_ICON_SVG}</button>
          </div>
        </div>
        <div class="ar-tab-editor" style="${isOpen ? '' : 'display:none'}"></div>
      </li>`;
    })
    .join('')}</ul>`;

  container.querySelectorAll('[data-message-id]').forEach((card) => {
    const messageId = card.dataset.messageId;
    card.querySelector('.ar-tab-toggle').addEventListener('click', () => {
      autoReplyOpenMessageId = autoReplyOpenMessageId === messageId ? null : messageId;
      renderAutoReplyTab();
    });
    if (autoReplyOpenMessageId === messageId) {
      const message = STATE.messages.find((mm) => mm.id === messageId);
      const source = message.autoReply || defaultAutoReply();
      const ar = { ...source, triggers: (source.triggers || []).map((t) => ({ ...t })) };
      bindAutoReplyPanel(card.querySelector('.ar-tab-editor'), ar, (updatedAr) => scheduleAutoReplySave(messageId, updatedAr));
    }
  });
}

document.getElementById('campaignMessageSelect').addEventListener('change', (e) => {
  const messageId = e.target.value;
  if (!messageId) return;
  setOpenSendPanel(null); // only one schedule editor open at a time app-wide
  resetScheduleEditor();
  sendPanelMode = 'schedule'; // opened specifically to schedule something, skip the Now tab
  campaignPickerOpen = false;
  campaignEditorMessageId = messageId;
  renderCampaignsTab();
});

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
  setBtnLabel(btn, 'Scanning...');
  const payload = { scope: scanScope };
  if (scanScope === 'chats') payload.contactFilter = document.getElementById('chatsContactFilter').value;
  const res = await call('listOpenChats', payload);
  btn.disabled = false;
  setBtnLabel(btn, 'Scan');
  if (!res.ok) {
    showToast(res.error || 'Could not scan chats.', 'error');
    return;
  }
  const chats = res.chats || [];
  for (const c of chats) {
    if (c.waId) chatSource.set(c.waId, c);
  }
  if (chats.length === 0) {
    showToast('No chats found — is web.whatsapp.com open and logged in?', 'info');
  } else {
    await call('saveFetchedChats', { chats });
  }
  renderListBuilder();
});

async function addManualContact() {
  const input = document.getElementById('manualContactNumber');
  const number = input.value.trim();
  if (!number) return;
  const btn = document.getElementById('manualAddBtn');
  btn.disabled = true;
  const res = await call('findContactByNumber', { number });
  btn.disabled = false;
  if (!res.ok) {
    showToast(res.error || 'Could not find that contact.', 'error');
    return;
  }
  chatSource.set(res.contact.waId, res.contact);
  selectedWaIds.add(res.contact.waId); // explicitly added, so pre-select it
  await call('saveFetchedChats', { chats: [res.contact] });
  input.value = '';
  renderListBuilder();
}
document.getElementById('manualAddBtn').addEventListener('click', addManualContact);
document.getElementById('manualContactNumber').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    addManualContact();
  }
});

// Minimal RFC4180-ish CSV parser — handles quoted fields, "" escaped
// quotes, and commas/newlines inside quotes, matching how downloadCsv()
// above quotes its own output (so re-importing an export round-trips).
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Pulls rows out of a CSV shaped either like downloadCsv()'s own export
// (Name, Type, ID / Number — re-importing a previous export just works,
// groups included) or a plain "phone number, name" list with no header at
// all. Two shapes come out:
//  - { waId, name, type }: the ID column already held a real WhatsApp id
//    (contains "@") — a group, community, or a previously-exported
//    contact. Used as-is, no lookup needed — this is what makes
//    export → trim rows → re-import work for *groups*, since there's no
//    way to look a group up by name (see the CSV import handler's own
//    comment for why), but re-using an id we already resolved once before
//    needs no lookup at all.
//  - { number, name }: a plain phone number, resolved live via
//    findContactByNumber the same way the manual add box does.
function extractContactsFromCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const numHeaderIdx = header.findIndex((h) => /phone|number|id/.test(h));
  const nameHeaderIdx = header.findIndex((h) => h === 'name');
  const typeHeaderIdx = header.findIndex((h) => h === 'type');
  let startIdx, idCol, nameCol, typeCol;
  if (numHeaderIdx !== -1) {
    startIdx = 1;
    idCol = numHeaderIdx;
    nameCol = nameHeaderIdx;
    typeCol = typeHeaderIdx;
  } else {
    // No recognizable header — guess column 0 is the id/number, column 1
    // (if present) is the name, and treat row 0 as a header to skip only if
    // it doesn't itself look like a phone number or a WhatsApp id.
    const first = rows[0][0] || '';
    startIdx = /[0-9]{6,}/.test(first) || first.includes('@') ? 0 : 1;
    idCol = 0;
    nameCol = rows[0].length > 1 ? 1 : -1;
    typeCol = -1;
  }
  const out = [];
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    const raw = (r[idCol] || '').trim();
    if (!raw) continue;
    const name = nameCol >= 0 ? (r[nameCol] || '').trim() : '';
    if (raw.includes('@')) {
      const declaredType = typeCol >= 0 ? (r[typeCol] || '').trim().toLowerCase() : '';
      out.push({
        waId: raw,
        name,
        type: declaredType || (raw.endsWith('@g.us') ? 'group' : 'contact')
      });
    } else {
      out.push({ number: raw, name });
    }
  }
  return out;
}

document.getElementById('csvImportBtn').addEventListener('click', () => {
  document.getElementById('csvImportInput').click();
});
document.getElementById('csvImportInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // so selecting the same file again still fires 'change'
  if (!file) return;
  const rows = extractContactsFromCsv(await file.text());
  if (rows.length === 0) {
    showToast('No phone numbers or WhatsApp ids found in that CSV.', 'error');
    return;
  }
  // No live WhatsApp lookup for plain phone numbers — a chat id built from
  // digits alone (number@c.us) is deterministic, and every send already
  // resolves/verifies its target chat as its own first step regardless
  // (sendRawMessage's assertFindChat call, which every sendTextMessage/
  // sendFileMessage goes through) — checking registration again ahead of
  // time here would just be redundant work done twice. A number that isn't
  // actually on WhatsApp fails there instead, once you try messaging it,
  // logged the same as any other per-chat send failure — not here, and not
  // blocking or slowing down the rest of the import.
  let added = 0;
  let alreadyIn = 0;
  const newlyResolved = [];
  for (const row of rows) {
    let contact;
    if (row.waId) {
      // Already a real WhatsApp id (a group/community, or a
      // previously-exported contact) — use it directly, no lookup needed.
      contact = {
        waId: row.waId,
        name: row.name || row.waId,
        type: row.type,
        number: row.type === 'contact' && !row.waId.includes('@g.us') ? row.waId.split('@')[0] : ''
      };
    } else {
      const digits = row.number.replace(/[^0-9]/g, '');
      contact = { waId: `${digits}@c.us`, name: row.name || digits, type: 'contact', number: digits };
    }
    if (chatSource.has(contact.waId)) alreadyIn++;
    else added++;
    chatSource.set(contact.waId, contact);
    selectedWaIds.add(contact.waId); // explicitly imported, so pre-select it
    newlyResolved.push(contact);
  }
  if (newlyResolved.length > 0) {
    await call('saveFetchedChats', { chats: newlyResolved });
  }
  renderListBuilder();
  showToast(
    `CSV import done: ${added} added, ${alreadyIn} already in your fetched chats. ` +
      `Numbers that turn out not to be on WhatsApp will show up as a failed send in the Log tab when you actually message them, not here.`,
    'success'
  );
});

document.getElementById('clearFetchedBtn').addEventListener('click', async () => {
  if (!(await showConfirmDialog('Clear the fetched chats list? Saved lists are not affected.', { confirmText: 'Clear', danger: true }))) return;
  await call('clearFetchedChats');
  chatSource = new Map();
  selectedWaIds = new Set();
  renderListBuilder();
});

document.getElementById('exportFetchedBtn').addEventListener('click', async () => {
  const chats = Array.from(chatSource.values());
  if (chats.length === 0) {
    showToast('Nothing fetched yet to export.', 'info');
    return;
  }
  const btn = document.getElementById('exportFetchedBtn');
  btn.disabled = true;
  await downloadCsv('whatsapp-fetched-chats.csv', chats);
  btn.disabled = false;
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

document.getElementById('extractGroupContactsBtn').addEventListener('click', async () => {
  const groups = Array.from(selectedWaIds)
    .map((waId) => chatSource.get(waId))
    .filter((c) => c && c.type === 'group');
  if (groups.length === 0) {
    showToast('Check at least one group above first (contacts have no members to extract).', 'error');
    return;
  }
  const btn = document.getElementById('extractGroupContactsBtn');
  btn.disabled = true;
  await downloadBulkGroupMembersCsv(groups, (done, total) => setBtnLabel(btn, `Extracting ${done}/${total}…`));
  setBtnLabel(btn, 'Extract contacts');
  btn.disabled = false;
});

function renderListBuilder() {
  const box = document.getElementById('listBuilderChecklist');
  const visible = filteredChatSource();
  box.innerHTML =
    visible
      .map((c) => {
        const numberSuffix = c.number ? ` <span class="muted">(${escapeHtml(c.number)})</span>` : '';
        const unsavedBadge = c.isSavedContact === false ? ' <span class="badge badge-unsaved">not saved</span>' : '';
        // Extracting a group's own WhatsApp membership (who's actually in
        // it) is a different thing from picking chats for a saved list —
        // only groups have members to extract, so the button only shows
        // there, next to (not inside) the checkbox label so clicking it
        // doesn't also toggle selection.
        const exportBtn =
          c.type === 'group'
            ? `<button class="icon-btn small-icon-btn" data-act="exportMembers" data-wa-id="${escapeHtml(c.waId)}" data-name="${escapeHtml(c.name)}" type="button" data-tooltip="Export this group's members to CSV">${EXPORT_ICON_SVG}</button>`
            : '';
        return `<div class="list-check-row">
          <label class="list-check-label"><input type="checkbox" class="list-builder-check" value="${escapeHtml(c.waId)}" ${selectedWaIds.has(c.waId) ? 'checked' : ''}/> ${escapeHtml(c.name)}${numberSuffix} <span class="badge badge-${c.type}">${c.type}</span>${unsavedBadge}</label>
          ${exportBtn}
        </div>`;
      })
      .join('') || '<span class="hint">Scan or add a contact above first.</span>';
  box.querySelectorAll('.list-builder-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedWaIds.add(cb.value);
      else selectedWaIds.delete(cb.value);
      document.getElementById('selectedCount').textContent = `${selectedWaIds.size} selected`;
    });
  });
  box.querySelectorAll('[data-act="exportMembers"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const b = e.currentTarget;
      b.disabled = true;
      await downloadGroupMembersCsv(b.dataset.name, b.dataset.waId);
      b.disabled = false;
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
  setBtnLabel('saveListBtn', 'Save list');
  document.getElementById('cancelEditListBtn').style.display = 'none';
  renderListBuilder();
}
document.getElementById('cancelEditListBtn').addEventListener('click', resetListForm);

document.getElementById('saveListBtn').addEventListener('click', async () => {
  const name = document.getElementById('listName').value.trim();
  if (!name) {
    showToast('Give this list a name.', 'error');
    return;
  }
  if (selectedWaIds.size === 0) {
    showToast('Select at least one group/contact.', 'error');
    return;
  }
  const members = Array.from(selectedWaIds).map((waId) => chatSource.get(waId)).filter(Boolean);
  await call('saveList', { list: { id: editingListId, name, members } });
  resetListForm();
  refresh();
});

// ---------- refreshing saved lists against live WhatsApp state ----------
// A saved list stores each member's chat data (waId/name/type/number)
// as of whenever it was built — it never hears about a group rename, a
// group you've since left/been removed from, or a contact you deleted.
// Refreshing re-scans WhatsApp the same way "Scan" does (groups/contacts/
// communities via scope 'all', plus every open 1:1 chat via scope 'chats'
// so manually-added non-contact numbers aren't false-flagged) and diffs
// each member's waId against that fresh set: found → adopt the live
// name/number (rename), not found → drop it (left/removed/deleted — a
// group or contact chat.list() would no longer surface).
async function fetchLiveChatMap() {
  const [allRes, chatsRes] = await Promise.all([
    call('listOpenChats', { scope: 'all' }),
    call('listOpenChats', { scope: 'chats', contactFilter: 'all' })
  ]);
  if (!allRes.ok && !chatsRes.ok) {
    return { ok: false, error: allRes.error || chatsRes.error || 'Could not reach WhatsApp Web.' };
  }
  const map = new Map();
  for (const c of [...(allRes.chats || []), ...(chatsRes.chats || [])]) {
    if (c.waId) map.set(c.waId, c);
  }
  for (const c of map.values()) chatSource.set(c.waId, c); // benefit the list builder too
  return { ok: true, map };
}

function diffListAgainstLive(list, liveMap) {
  const kept = [];
  const removed = [];
  let renamed = 0;
  for (const m of list.members || []) {
    const live = liveMap.get(m.waId);
    if (!live) {
      removed.push(m);
      continue;
    }
    if (live.name !== m.name || (live.number || '') !== (m.number || '')) renamed++;
    kept.push({ ...m, name: live.name, number: live.number || '' });
  }
  return { kept, removed, renamed };
}

async function refreshList(list, btn) {
  if (btn) btn.disabled = true;
  const live = await fetchLiveChatMap();
  if (btn) btn.disabled = false;
  if (!live.ok) {
    showToast(live.error, 'error');
    return;
  }
  const { kept, removed, renamed } = diffListAgainstLive(list, live.map);
  if (renamed === 0 && removed.length === 0) {
    showToast(`"${list.name}" is already up to date.`, 'success');
    return;
  }
  if (removed.length > 0) {
    const names = removed.map((m) => m.name).slice(0, 5).join(', ') + (removed.length > 5 ? '…' : '');
    const emptyWarning = kept.length === 0 ? ' This list will end up empty.' : '';
    const ok = await showConfirmDialog(
      `Refreshing "${list.name}": ${renamed > 0 ? `${renamed} renamed, ` : ''}${removed.length} no longer reachable (left, removed, or deleted) and will be dropped — ${names}.${emptyWarning}`,
      { confirmText: 'Refresh', danger: true }
    );
    if (!ok) return;
  }
  await call('saveList', { list: { id: list.id, name: list.name, members: kept } });
  showToast(`"${list.name}" refreshed — ${renamed} renamed, ${removed.length} removed.`, 'success');
  refresh();
}

document.getElementById('refreshAllListsBtn').addEventListener('click', async (e) => {
  if (STATE.lists.length === 0) {
    showToast('No saved lists yet.', 'info');
    return;
  }
  const btn = e.currentTarget;
  btn.disabled = true;
  const live = await fetchLiveChatMap();
  btn.disabled = false;
  if (!live.ok) {
    showToast(live.error, 'error');
    return;
  }
  const diffs = STATE.lists.map((list) => ({ list, ...diffListAgainstLive(list, live.map) }));
  const changed = diffs.filter((d) => d.renamed > 0 || d.removed.length > 0);
  if (changed.length === 0) {
    showToast('All lists are already up to date.', 'success');
    return;
  }
  const totalRenamed = changed.reduce((sum, d) => sum + d.renamed, 0);
  const totalRemoved = changed.reduce((sum, d) => sum + d.removed.length, 0);
  if (totalRemoved > 0) {
    const ok = await showConfirmDialog(
      `Refresh ${changed.length} list${changed.length > 1 ? 's' : ''}: ${totalRenamed} renamed, ${totalRemoved} member${totalRemoved > 1 ? 's' : ''} no longer reachable and will be dropped across them.`,
      { confirmText: 'Refresh all', danger: true }
    );
    if (!ok) return;
  }
  for (const d of changed) {
    await call('saveList', { list: { id: d.list.id, name: d.list.name, members: d.kept } });
  }
  showToast(`Refreshed ${changed.length} list${changed.length > 1 ? 's' : ''} — ${totalRenamed} renamed, ${totalRemoved} removed.`, 'success');
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
        <button class="icon-btn small-icon-btn" data-act="refresh" type="button" data-tooltip="Refresh from WhatsApp (names, removed groups/contacts)">${REFRESH_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn" data-act="edit" type="button" data-tooltip="Edit">${EDIT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn" data-act="export" type="button" data-tooltip="Export to CSV">${EXPORT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn danger" data-act="del" type="button" data-tooltip="Delete">${DELETE_ICON_SVG}</button>
      </div>
    </div>`;
    li.querySelector('[data-act="refresh"]').addEventListener('click', async (e) => {
      await refreshList(l, e.currentTarget);
    });
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingListId = l.id;
      selectedWaIds = new Set(members.map((m) => m.waId));
      for (const m of members) chatSource.set(m.waId, m); // merge so they show without a fresh scan
      listSearchQuery = '';
      document.getElementById('listSearchInput').value = '';
      document.getElementById('listName').value = l.name;
      document.getElementById('listBuilderTitle').textContent = `Editing "${l.name}"`;
      setBtnLabel('saveListBtn', 'Update list');
      document.getElementById('cancelEditListBtn').style.display = '';
      renderListBuilder();
      document.querySelector('[data-tab="lists"]').click();
    });
    li.querySelector('[data-act="export"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await downloadCsv(`${l.name.replace(/[^a-z0-9]+/gi, '_') || 'list'}.csv`, members);
      btn.disabled = false;
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      const ok = await showConfirmDialog(`Delete list "${l.name}"? Any schedules using it will have it removed from their targets.`, {
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;
      await call('deleteList', { id: l.id });
      refresh();
    });
    ul.appendChild(li);
  }
}

// ============ LOG ============
document.getElementById('clearLogBtn').addEventListener('click', async () => {
  if (!(await showConfirmDialog('Clear the entire activity log?', { confirmText: 'Clear', danger: true }))) return;
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

// How many of a given send's logged messages are still eligible for
// "delete for everyone" (successfully sent, we captured its WhatsApp
// message id, and it hasn't already been deleted) — computed over the full
// log regardless of the current search/status filter, since the delete
// action itself always targets the whole send.
function deletableCountsByCampaign() {
  const counts = new Map(); // campaignId -> remaining count
  for (const l of STATE.log) {
    if (l.status === 'success' && l.waId && l.msgId && !l.deletedForEveryone) {
      counts.set(l.campaignId, (counts.get(l.campaignId) || 0) + 1);
    }
  }
  return counts;
}

function renderLog() {
  const progressEl = document.getElementById('deleteRunProgress');
  const deleteRun = deleteRunEntry ? STATE.activeRuns[deleteRunEntry.runId] : null;
  if (deleteRun) {
    progressEl.innerHTML = `
      ${renderProgressBlock(deleteRun)}
      ${deleteRun.done ? `<button class="ghost small-inline" type="button" data-act="closeDeleteRun">${CHECK_ICON_SVG}<span class="btn-label">Close</span></button>` : '<p class="hint">Deleting for everyone — this updates live.</p>'}
    `;
    const closeBtn = progressEl.querySelector('[data-act="closeDeleteRun"]');
    if (closeBtn) closeBtn.addEventListener('click', () => { setDeleteRunId(null); renderLog(); });
  } else if (deleteRunEntry && Date.now() - (deleteRunEntry.assignedAt || 0) < 8000) {
    // background.js hasn't necessarily written the run's progress record
    // yet — same grace window as messageRunIds, see buildSendPanel.
    progressEl.innerHTML = '<p class="hint">Starting…</p>';
  } else {
    progressEl.innerHTML = '';
    if (deleteRunEntry) setDeleteRunId(null); // run finished and was pruned — stop looking for it
  }

  const ul = document.getElementById('logList');
  const query = logSearchQuery.trim().toLowerCase();
  const filterActive = !!query || logStatusFilter !== 'all';
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

  // The bulk delete button lives up top next to Clear log, not inline per
  // entry. With no search/status filter active it targets the newest send
  // that still has anything left to delete (STATE.log is newest-first).
  // With a filter active, it targets exactly what's currently visible —
  // deleting only the filtered messages, not the rest of whatever send(s)
  // they came from.
  const bulkBtn = document.getElementById('bulkDeleteForEveryoneBtn');
  if (filterActive) {
    const eligible = filtered.filter((l) => l.status === 'success' && l.waId && l.msgId && !l.deletedForEveryone);
    if (eligible.length > 1) {
      bulkBtn.style.display = '';
      bulkBtn.dataset.tooltip = `Delete for everyone — filtered messages (${eligible.length})`;
      bulkBtn.dataset.mode = 'filtered';
      bulkBtn.dataset.logIds = JSON.stringify(eligible.map((l) => l.id));
      bulkBtn.dataset.count = eligible.length;
    } else {
      bulkBtn.style.display = 'none';
    }
  } else {
    const deletableCounts = deletableCountsByCampaign();
    const newestDeletable = STATE.log.find((l) => (deletableCounts.get(l.campaignId) || 0) > 1);
    if (newestDeletable) {
      const count = deletableCounts.get(newestDeletable.campaignId);
      bulkBtn.style.display = '';
      bulkBtn.dataset.tooltip = `Delete for everyone — this send (${count} messages)`;
      bulkBtn.dataset.mode = 'campaign';
      bulkBtn.dataset.campaignId = newestDeletable.campaignId;
      bulkBtn.dataset.count = count;
    } else {
      bulkBtn.style.display = 'none';
    }
  }

  ul.innerHTML = '';
  if (filtered.length === 0) {
    ul.innerHTML = `<li class="item-text">${STATE.log.length === 0 ? 'No activity yet.' : 'No log entries match this search/filter.'}</li>`;
  }
  for (const l of filtered) {
    const li = document.createElement('li');
    const canDeleteThis = l.status === 'success' && l.waId && l.msgId && !l.deletedForEveryone;
    li.innerHTML = `<div class="item-text">
      <span class="log-status-${l.status}">${l.status.toUpperCase()}</span>
      ${l.campaignName ? ' · ' + escapeHtml(l.campaignName) : ''}
      ${l.chatName ? ' → ' + escapeHtml(l.chatName) : ''}<br/>
      <span class="log-time">${new Date(l.timestamp).toLocaleString()}</span><br/>
      ${escapeHtml(l.detail || '')}
      ${l.deletedForEveryone ? '<br/><span class="muted">Deleted for everyone ✓</span>' : ''}
    </div>
    ${
      canDeleteThis
        ? `<div class="log-entry-actions">
      <button class="icon-btn small-icon-btn danger" type="button" data-act="deleteForEveryone" data-log-id="${l.id}" data-tooltip="Delete for everyone">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg>
      </button>
    </div>`
        : ''
    }`;
    ul.appendChild(li);
  }
  ul.querySelectorAll('[data-act="deleteForEveryone"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirmDialog(
        'Delete this message for everyone? This only works if WhatsApp still allows it (a limited time after sending).',
        { confirmText: 'Delete', danger: true }
      );
      if (!ok) return;
      const res = await call('deleteForEveryone', { logId: btn.dataset.logId });
      if (res.ok && res.runId) setDeleteRunId(res.runId);
      else if (!res.ok) showToast(res.error || 'Could not start delete.', 'error');
      refresh();
    });
  });
}

document.getElementById('bulkDeleteForEveryoneBtn').addEventListener('click', async () => {
  const btn = document.getElementById('bulkDeleteForEveryoneBtn');
  const mode = btn.dataset.mode;
  const count = btn.dataset.count;
  if (!mode) return;
  const scopeText = mode === 'filtered' ? 'filtered' : 'from this send';
  const okBulk = await showConfirmDialog(
    `Delete all ${count} messages ${scopeText} for everyone? This only works if WhatsApp still allows it (a limited time after sending) — chats past that window will be skipped and logged as failed.`,
    { confirmText: 'Delete all', danger: true }
  );
  if (!okBulk) return;
  const res =
    mode === 'filtered'
      ? await call('deleteForEveryoneByIds', { logIds: JSON.parse(btn.dataset.logIds || '[]') })
      : await call('deleteForEveryoneBulk', { campaignId: btn.dataset.campaignId });
  if (res.ok && res.runId) setDeleteRunId(res.runId);
  else if (!res.ok) showToast(res.error || 'Could not start delete.', 'error');
  refresh();
});

// ============ SETTINGS ============
function renderSettings() {
  renderActivationCard();
  const s = STATE.settings;
  document.getElementById('jitterMinutes').value = s.jitterMinutes ?? 4;
  const [min, max] = s.defaultDelayBetweenMsMs || [20000, 45000];
  document.getElementById('delayMin').value = Math.round(min / 1000);
  document.getElementById('delayMax').value = Math.round(max / 1000);
  const [lmin, lmax] = s.defaultDelayBetweenListsMs || [30000, 60000];
  document.getElementById('listDelayMin').value = Math.round(lmin / 1000);
  document.getElementById('listDelayMax').value = Math.round(lmax / 1000);
  document.getElementById('consentCheckboxSettings').checked = !!s.consentAccepted;
  document.getElementById('headerText').value = s.headerText || '';
  document.getElementById('footerText').value = s.footerText || '';
}

// ============ ACTIVATION ============
// No accounts — a key you were issued (see server/README.md) is all there
// is. background.js/license.js talk to the license server; this just
// shows the screen and forwards the key.
async function submitActivation() {
  const btn = document.getElementById('activateBtn');
  const input = document.getElementById('activationKeyInput');
  const errEl = document.getElementById('activationError');
  errEl.style.display = 'none';
  const key = input.value.trim();
  if (!key) {
    errEl.textContent = 'Enter your activation key.';
    errEl.style.display = '';
    return;
  }
  btn.disabled = true;
  setBtnLabel(btn, 'Activating…');
  const res = await call('activate', { key });
  btn.disabled = false;
  setBtnLabel(btn, 'Activate');
  if (!res.ok) {
    errEl.textContent = res.error || 'Invalid or revoked key.';
    errEl.style.display = '';
    return;
  }
  input.value = '';
  showToast(`Activated — welcome, ${res.name || 'there'}.`, 'success');
  refresh();
}
document.getElementById('activateBtn').addEventListener('click', submitActivation);
document.getElementById('activationKeyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitActivation();
  }
});

document.getElementById('deactivateBtn').addEventListener('click', async () => {
  const ok = await showConfirmDialog(
    "Deactivate this device? Your data stays on this device; you'll need to enter a key again to keep using the extension (this device keeps its seat on the key until an admin resets it).",
    { confirmText: 'Deactivate', danger: true }
  );
  if (!ok) return;
  await call('deactivate');
  refresh();
});

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 45000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} h ago`;
  return new Date(ts).toLocaleString();
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// The activation/sync UI lives at the top of the Settings tab, as its own
// card above the rest of the settings — see renderSettings(), which calls
// this. Hidden entirely in dev mode (license.enforced false, i.e.
// LICENSE_SERVER is empty in license.js), since there's nothing to show.
function renderActivationCard() {
  const license = STATE.license || {};
  const card = document.getElementById('activationCard');
  card.style.display = license.enforced ? '' : 'none';
  if (!license.enforced) return;
  document.getElementById('activationNameText').textContent = license.name || 'Activated';
  document.getElementById('activationKeyLine').textContent = maskKey(license.key);
  const seatsText = license.master
    ? 'Master key'
    : license.seats != null
      ? `${license.used ?? '?'}/${license.seats} device${license.seats === 1 ? '' : 's'}`
      : '';
  const expiryText = license.master ? '' : license.expires ? `expires ${license.expires}` : 'no expiry';
  document.getElementById('activationExpiryLine').textContent = [seatsText, expiryText].filter(Boolean).join(' · ');

  const syncOn = !!STATE.settings.syncEnabled;
  document.getElementById('syncEnabledCheck').checked = syncOn;
  document.getElementById('syncNowBtn').style.display = syncOn ? '' : 'none';
  const dot = document.getElementById('syncStatusDot');
  const text = document.getElementById('syncStatusText');
  const cs = STATE.cloudSync || {};
  if (!syncOn) {
    dot.className = 'wa-status-dot off';
    text.textContent = 'Sync is off';
  } else if (cs.inProgress) {
    dot.className = 'wa-status-dot checking';
    text.textContent = 'Syncing…';
  } else if (cs.lastError) {
    dot.className = 'wa-status-dot not-ready';
    text.textContent = cs.lastError;
  } else if (cs.lastAt) {
    dot.className = 'wa-status-dot ready';
    text.textContent = `Synced · ${relativeTime(cs.lastPushAt || cs.lastPulledAt || cs.lastAt)}`;
  } else {
    dot.className = 'wa-status-dot checking';
    text.textContent = 'Waiting for first sync…';
  }
  text.dataset.tooltip = cs.lastError || (cs.lastAt ? `Cloud copy last changed ${new Date(cs.lastAt).toLocaleString()}` : '');
}

document.getElementById('syncEnabledCheck').addEventListener('change', async (e) => {
  await call('saveSettings', { settings: { syncEnabled: e.target.checked } });
  refresh();
});
document.getElementById('syncNowBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  await call('syncNow');
  btn.disabled = false;
  refresh();
});

// ============ KEYS (master key admin) ============
// Only functional for a master key — the tab is hidden otherwise, and the
// server rejects these calls unless the request carries one. Key records
// are just {name, seats, devices, expires?} (see server/README.md).
const COPY_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>';
const REVOKE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 0 1 6.32 12.9L7.1 5.68A7.96 7.96 0 0 1 12 4Zm0 16a8 8 0 0 1-6.32-12.9L16.9 18.32A7.96 7.96 0 0 1 12 20Z"/></svg>';

let keysLoaded = false;
let allKeys = [];
let editingKey = null; // { key, devices, master } while editing
let keysSearchQuery = '';

function randCode6() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no confusable 0/O, 1/I/L
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
// Blank key field → WAS-<first word of customer name>-<random 6>; a typed
// key always gets the random tail appended so two "ALI" keys never collide.
function genKey(name) {
  const firstWord = (name || 'Customer').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'CUSTOMER';
  return `WAS-${firstWord}-${randCode6()}`;
}
function withRandomSuffix(customKey) {
  return `${customKey.trim().replace(/-+$/, '')}-${randCode6()}`;
}

// Validity: the Years/Months/Days boxes and the exact-date field stay in
// sync both ways; the date field is the source of truth on save.
function today0() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtLocalDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setHours(0, 0, 0, 0);
  return d;
}
function diffYMD(from, to) {
  let y = to.getFullYear() - from.getFullYear();
  let m = to.getMonth() - from.getMonth();
  let d = to.getDate() - from.getDate();
  if (d < 0) {
    m--;
    d += new Date(to.getFullYear(), to.getMonth(), 0).getDate();
  }
  if (m < 0) {
    y--;
    m += 12;
  }
  return { y: Math.max(0, y), m: Math.max(0, m), d: Math.max(0, d) };
}
function timeLeftText(expiresStr) {
  const target = parseLocalDate(expiresStr);
  if (!target) return '';
  const t0 = today0();
  if (target < t0) return 'expired';
  if (target.getTime() === t0.getTime()) return 'expires today';
  const { y, m, d } = diffYMD(t0, target);
  const unit = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
  if (y > 0) return `${unit(y, 'year')}${m > 0 ? ` ${unit(m, 'month')}` : ''} left`;
  if (m > 0) return `${unit(m, 'month')}${d > 0 ? ` ${unit(d, 'day')}` : ''} left`;
  return `${unit(d, 'day')} left`;
}
function keyDurationToDate() {
  const y = parseInt(document.getElementById('keyYears').value, 10) || 0;
  const m = parseInt(document.getElementById('keyMonths').value, 10) || 0;
  const d = parseInt(document.getElementById('keyDays').value, 10) || 0;
  const dateEl = document.getElementById('keyExpiry');
  if (y <= 0 && m <= 0 && d <= 0) {
    dateEl.value = '';
    return;
  }
  const dt = today0();
  dt.setFullYear(dt.getFullYear() + y);
  dt.setMonth(dt.getMonth() + m);
  dt.setDate(dt.getDate() + d);
  dateEl.value = fmtLocalDate(dt);
}
function keyDateToDuration() {
  const target = parseLocalDate(document.getElementById('keyExpiry').value);
  const [yEl, mEl, dEl] = ['keyYears', 'keyMonths', 'keyDays'].map((id) => document.getElementById(id));
  if (!target) {
    yEl.value = mEl.value = dEl.value = '';
    return;
  }
  const { y, m, d } = diffYMD(today0(), target);
  yEl.value = y || '';
  mEl.value = m || '';
  dEl.value = d || '';
}
['keyYears', 'keyMonths', 'keyDays'].forEach((id) => document.getElementById(id).addEventListener('input', keyDurationToDate));
document.getElementById('keyExpiry').addEventListener('input', keyDateToDuration);
document.getElementById('keyExpiry').addEventListener('change', keyDateToDuration);

function setKeyFormMsg(text, isError) {
  const el = document.getElementById('keyFormMsg');
  el.textContent = text || '';
  el.className = `hint${isError ? ' warn' : ''}`;
  el.style.display = text ? '' : 'none';
}

function resetKeyForm() {
  editingKey = null;
  document.getElementById('keyFormTitle').textContent = 'Create a key';
  setBtnLabel('keySaveBtn', 'Create key');
  document.getElementById('keyFormCancelBtn').style.display = 'none';
  document.getElementById('keyName').value = '';
  const codeEl = document.getElementById('keyCode');
  codeEl.value = '';
  codeEl.disabled = false;
  document.getElementById('keySeats').value = 2;
  ['keyYears', 'keyMonths', 'keyDays', 'keyExpiry'].forEach((id) => (document.getElementById(id).value = ''));
  setKeyFormMsg('');
}

function loadKeyForEdit(k) {
  editingKey = { key: k.key, devices: k.devices || [], master: !!k.master };
  document.getElementById('keyFormTitle').textContent = 'Edit key';
  setBtnLabel('keySaveBtn', 'Save changes');
  document.getElementById('keyFormCancelBtn').style.display = '';
  document.getElementById('keyName').value = k.name || '';
  const codeEl = document.getElementById('keyCode');
  codeEl.value = k.key;
  codeEl.disabled = true; // the key id itself can't be renamed
  document.getElementById('keySeats').value = k.seats || 2;
  document.getElementById('keyExpiry').value = k.expires || '';
  keyDateToDuration();
  setKeyFormMsg(`Editing ${k.key} — current expiry: ${k.expires || 'never'}.`);
  document.getElementById('keyName').scrollIntoView({ block: 'nearest' });
}

function renderKeysTabVisibility() {
  const isMaster = !!(STATE.license && STATE.license.master);
  const tabBtn = document.getElementById('keysTabBtn');
  tabBtn.style.display = isMaster ? '' : 'none';
  const keysTabActive = document.getElementById('tab-keys').classList.contains('active');
  if (!isMaster && keysTabActive) {
    document.querySelector('[data-tab="messages"]').click(); // e.g. lastTab was "keys" from a master session
  } else if (isMaster && keysTabActive && !keysLoaded) {
    loadKeys();
  }
}

async function loadKeys() {
  keysLoaded = true;
  const ul = document.getElementById('keysList');
  ul.innerHTML = '<li class="item-text">Loading…</li>';
  const res = await call('adminListKeys');
  if (!res.ok) {
    ul.innerHTML = `<li class="item-text">${escapeHtml(res.error || 'Failed to load keys')}</li>`;
    return;
  }
  allKeys = res.keys || [];
  renderKeys();
}

function renderKeys() {
  const ul = document.getElementById('keysList');
  const q = keysSearchQuery.trim().toLowerCase();
  const keys = q ? allKeys.filter((k) => (k.key || '').toLowerCase().includes(q) || (k.name || '').toLowerCase().includes(q)) : allKeys;
  document.getElementById('keysCount').textContent = `(${keys.length})`;
  ul.innerHTML = '';
  if (keys.length === 0) {
    ul.innerHTML = `<li class="item-text">${q ? 'No keys match your search.' : 'No keys yet — create one above.'}</li>`;
    return;
  }
  for (const k of keys) {
    const li = document.createElement('li');
    if (k.revoked) li.className = 'key-revoked';
    const used = Array.isArray(k.devices) ? k.devices.length : 0;
    const seats = k.seats == null ? '?' : k.seats;
    const left = k.expires ? timeLeftText(k.expires) : '';
    const metaLines = k.revoked
      ? ['REVOKED']
      : k.master
        ? ['Master key — unlimited devices, never expires']
        : [`${used}/${seats} devices`, k.expires ? `Expires ${k.expires}${left ? ` (${left})` : ''}` : 'No expiry'];
    li.innerHTML = `<div class="item-row">
      <div class="item-text">
        <div class="key-code">${escapeHtml(k.key)}</div>
        <div>${escapeHtml(k.name || '')}</div>
        <div class="key-meta">${metaLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>
      </div>
      <div class="item-actions">
        <button class="icon-btn small-icon-btn" data-act="copy" type="button" data-tooltip="Copy key">${COPY_ICON_SVG}</button>
        ${
          k.master
            ? '<span class="badge badge-group">master</span>'
            : `<button class="icon-btn small-icon-btn" data-act="edit" type="button" data-tooltip="Edit name, seats or expiry">${EDIT_ICON_SVG}</button>
        <button class="icon-btn small-icon-btn" data-act="reset" type="button" data-tooltip="Reset devices — frees every seat on this key">${REFRESH_ICON_SVG}</button>
        ${k.revoked ? '' : `<button class="icon-btn small-icon-btn danger" data-act="revoke" type="button" data-tooltip="Revoke — stops working within minutes">${REVOKE_ICON_SVG}</button>`}
        <button class="icon-btn small-icon-btn danger" data-act="del" type="button" data-tooltip="Delete permanently">${DELETE_ICON_SVG}</button>`
        }
      </div>
    </div>`;
    li.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(k.key);
        showToast('Key copied.', 'success');
      } catch (_) {
        showToast('Could not copy — select it and copy manually.', 'error');
      }
    });
    const editBtn = li.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.addEventListener('click', () => loadKeyForEdit(k));
    const resetBtn = li.querySelector('[data-act="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        if (!(await showConfirmDialog(`Free all device seats on ${k.key}? Every device using it will have to re-enter the key.`, { confirmText: 'Reset devices', danger: true }))) return;
        const record = { name: k.name, seats: k.seats || 2, devices: [] };
        if (k.expires) record.expires = k.expires;
        const r = await call('adminPutKey', { key: k.key, record });
        if (r.ok) loadKeys();
        else showToast(r.error || 'Failed', 'error');
      });
    }
    const revokeBtn = li.querySelector('[data-act="revoke"]');
    if (revokeBtn) {
      revokeBtn.addEventListener('click', async () => {
        if (!(await showConfirmDialog(`Revoke ${k.key}? It stops working within minutes on every device.`, { confirmText: 'Revoke', danger: true }))) return;
        const r = await call('adminRevokeKey', { key: k.key });
        if (r.ok) loadKeys();
        else showToast(r.error || 'Failed', 'error');
      });
    }
    const delBtn = li.querySelector('[data-act="del"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!(await showConfirmDialog(`Delete ${k.key} permanently? (Its synced data stays in KV until you clean it up.)`, { confirmText: 'Delete', danger: true }))) return;
        const r = await call('adminDeleteKey', { key: k.key });
        if (r.ok) loadKeys();
        else showToast(r.error || 'Failed', 'error');
      });
    }
    ul.appendChild(li);
  }
}

document.getElementById('keySaveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('keySaveBtn');
  const name = document.getElementById('keyName').value.trim() || 'Customer';
  let seats = parseInt(document.getElementById('keySeats').value, 10);
  if (!Number.isFinite(seats) || seats < 1) seats = 2;
  const typedKey = document.getElementById('keyCode').value.trim();
  if (!editingKey && typedKey.includes(':')) {
    setKeyFormMsg('A key cannot contain ":".', true);
    return;
  }
  const key = editingKey ? editingKey.key : typedKey ? withRandomSuffix(typedKey) : genKey(name);
  const record = { name, seats, devices: editingKey ? editingKey.devices : [] };
  const expires = document.getElementById('keyExpiry').value;
  if (expires) record.expires = expires;
  if (editingKey && editingKey.master) record.master = true;
  btn.disabled = true;
  setKeyFormMsg('Saving…');
  const r = await call('adminPutKey', { key, record });
  btn.disabled = false;
  if (!r.ok) {
    setKeyFormMsg(r.error || 'Failed', true);
    return;
  }
  const wasCreate = !editingKey;
  resetKeyForm();
  await loadKeys();
  setKeyFormMsg(wasCreate ? `Created — give this key to the customer: ${key}` : `Updated ${key}`);
});
document.getElementById('keyFormCancelBtn').addEventListener('click', resetKeyForm);
document.getElementById('keysRefreshBtn').addEventListener('click', loadKeys);
document.getElementById('keysTabBtn').addEventListener('click', () => {
  if (!keysLoaded) loadKeys();
});

function updateKeysSearchClearBtn() {
  document.getElementById('keysSearchClearBtn').classList.toggle('visible', keysSearchQuery.length > 0);
}
chrome.storage.local.get(['keysSearchQuery'], (data) => {
  if (data.keysSearchQuery) {
    keysSearchQuery = data.keysSearchQuery;
    document.getElementById('keysSearchInput').value = keysSearchQuery;
  }
  updateKeysSearchClearBtn();
});
document.getElementById('keysSearchInput').addEventListener('input', (e) => {
  keysSearchQuery = e.target.value;
  chrome.storage.local.set({ keysSearchQuery });
  updateKeysSearchClearBtn();
  renderKeys();
});
document.getElementById('keysSearchClearBtn').addEventListener('click', () => {
  keysSearchQuery = '';
  document.getElementById('keysSearchInput').value = '';
  chrome.storage.local.set({ keysSearchQuery });
  updateKeysSearchClearBtn();
  renderKeys();
});

let saveSettingsBtnResetTimer = null;
document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveSettingsBtn');
  const jitterMinutes = Number(document.getElementById('jitterMinutes').value) || 0;
  const min = secToMs(document.getElementById('delayMin').value, 20000);
  const max = secToMs(document.getElementById('delayMax').value, 45000);
  const lmin = secToMs(document.getElementById('listDelayMin').value, 30000);
  const lmax = secToMs(document.getElementById('listDelayMax').value, 60000);
  const consentAccepted = document.getElementById('consentCheckboxSettings').checked;
  const headerText = document.getElementById('headerText').value;
  const footerText = document.getElementById('footerText').value;
  await call('saveSettings', {
    settings: {
      jitterMinutes,
      defaultDelayBetweenMsMs: [min, Math.max(min, max)],
      defaultDelayBetweenListsMs: [lmin, Math.max(lmin, lmax)],
      consentAccepted,
      headerText,
      footerText
    }
  });
  refresh();
  setBtnLabel(btn, 'Saved ✓');
  btn.classList.add('save-confirmed');
  clearTimeout(saveSettingsBtnResetTimer);
  saveSettingsBtnResetTimer = setTimeout(() => {
    setBtnLabel(btn, 'Save');
    btn.classList.remove('save-confirmed');
  }, 1800);
});

// background.js writes log entries (and other state) directly to
// chrome.storage while a campaign runs, with the popup possibly still open
// on the Log tab — without this, nothing tells the popup that happened and
// it looks frozen until closed and reopened. Draft-only writes are excluded
// since those happen on every keystroke while composing a message and are
// already reflected live in the form — a full refresh() on each one would
// make typing feel laggy for no benefit.
// Keys whose own write handler already applies the change directly to the
// DOM (checkbox states, badge text, etc.) — reacting to their own storage
// write by tearing down and rebuilding the whole send panel would just
// reset scroll position inside it for no visible benefit, which is exactly
// what made checking chats in a long list feel like it kept jumping back to
// the top on every click.
const SELF_APPLIED_STORAGE_KEYS = new Set(['messageDraft', 'listSelections']);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.length === 1 && SELF_APPLIED_STORAGE_KEYS.has(keys[0])) return;
  refresh();
});

// A fresh, real-time check every time the popup opens — not cached state —
// since the extension being "on" and a message actually being sendable are
// different things: reloading the extension, WhatsApp Web not being open,
// or the page not having finished loading yet would all still let a send
// attempt start and then fail. This is what a send attempt itself checks
// (pingContentScript), just surfaced up front instead of only discovered
// after clicking Send.
async function checkWaStatusLive() {
  const dot = document.getElementById('waStatusDot');
  const text = document.getElementById('waStatusText');
  dot.className = 'wa-status-dot checking';
  text.textContent = 'WhatsApp Status: checking…';
  const res = await call('checkWaStatus');
  if (res.ok && res.ready) {
    dot.className = 'wa-status-dot ready';
    text.textContent = 'WhatsApp Status: ready';
    document.getElementById('waStatusLine').dataset.tooltip = 'WhatsApp Web is ready — sends should go through.';
  } else {
    dot.className = 'wa-status-dot not-ready';
    text.textContent = 'WhatsApp Status: not ready';
    document.getElementById('waStatusLine').dataset.tooltip = res.reason || 'WhatsApp Web is not ready — a send would fail right now.';
  }
}

// ============ CUSTOM TOOLTIPS ============
// One shared element, positioned from each trigger's real measured
// position at hover time — see popup.css's ".custom-tooltip" for why a
// pure-CSS approach couldn't do this safely (an element near an edge would
// either render off-screen, or overflow in a way that could trick the
// extension popup's own auto-resize into a hover/resize jitter loop).
// Self-contained: touches nothing else in this file, and any element
// anywhere just needs a `data-tooltip="..."` attribute to get one — no
// per-element CSS or wiring required.
(function () {
  const tooltip = document.createElement('div');
  tooltip.className = 'custom-tooltip';
  document.body.appendChild(tooltip);
  let currentTarget = null;
  let showTimer = null;
  const MARGIN = 6;

  function hideTooltip() {
    clearTimeout(showTimer);
    tooltip.classList.remove('visible');
    currentTarget = null;
  }

  function showTooltip(target) {
    const text = target.dataset.tooltip;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.classList.add('visible');

    const targetRect = target.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const tipRect = tooltip.getBoundingClientRect();

    // Prefer centered above the target; flip below if there's no room.
    let top = targetRect.top - tipRect.height - MARGIN;
    let placement = 'top';
    if (top < MARGIN) {
      top = targetRect.bottom + MARGIN;
      placement = 'bottom';
    }
    top = Math.min(top, viewportHeight - tipRect.height - MARGIN);

    // Clamp horizontally so the box itself never runs off either edge —
    // this is what actually fixes "too far right/left" for every element,
    // not just a hand-picked few.
    let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
    left = Math.max(MARGIN, Math.min(left, viewportWidth - tipRect.width - MARGIN));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.dataset.placement = placement;
    // Keep the little arrow pointing at the real button center even after
    // the box above got shifted to stay on-screen.
    const arrowLeft = Math.max(8, Math.min(targetRect.left + targetRect.width / 2 - left, tipRect.width - 8));
    tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);
  }

  document.addEventListener('pointerover', (e) => {
    // Self-heals if a re-render (refresh()) swapped out the element a
    // tooltip was showing for, since that element no longer exists to
    // ever fire a matching pointerout.
    if (currentTarget && !document.body.contains(currentTarget)) hideTooltip();
    const target = e.target.closest('[data-tooltip]');
    if (!target || target === currentTarget) return;
    hideTooltip();
    currentTarget = target;
    showTimer = setTimeout(() => showTooltip(target), 300);
  });
  document.addEventListener('pointerout', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (!target || target !== currentTarget) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    hideTooltip();
  });
  document.addEventListener('scroll', hideTooltip, true);
})();

// ============ HEADER LOGO (SVG) ============
// icons/header-logo.svg is the full downloaded LottieFiles animation
// ("WhatsApp Default State" — phone-in-bubble + a wobbling accent + ring
// arcs that fade in/out), exported as a plain SVG with native SMIL
// (<animate>/<animateTransform>) instead of Lottie's JSON+JS player — same
// look, no 168KB vendored library or animation loop to run. Its white
// background rect was stripped from the file itself (so the icon sits
// transparently on the header's own green) and its viewBox tightened from
// "0 0 500 500" to "50 50 400 400" (checked against every layer's own
// motion — the wobble's rotate+scale swing and both ring arcs — so nothing
// clips at the crop edges). Fetched and inlined (rather than <img
// src="...">) so prefers-reduced-motion can strip every animate element:
// the phone bubble has no animation of its own so it's unaffected, while
// the wobble/flash/ring-arc layers all settle on their own authored rest
// state (the arcs and flash image default to opacity 0, i.e. hidden)
// instead of freezing mid-motion.
(function () {
  const container = document.getElementById('appLogoImg');
  fetch('icons/header-logo.svg')
    .then((r) => r.text())
    .then((svgText) => {
      container.innerHTML = svgText;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        container.querySelectorAll('animate, animateTransform').forEach((el) => el.remove());
      }
    })
    .catch(() => {}); // a missing logo shouldn't break the rest of the popup
})();

restoreDraft();
renderMessageHfControl();
refresh();
// Each popup open: re-validate the cached key (catches one revoked while
// the browser was closed) and check for changes other devices pushed. Both
// no-op instantly when not applicable; any change lands in storage and
// comes back through the storage.onChanged -> refresh() path above.
call('licenseStatus');
call('syncPollNow');
checkWaStatusLive();
