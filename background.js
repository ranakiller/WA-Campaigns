// background.js — service worker: owns storage, scheduling (chrome.alarms),
// and talks to the content script running inside the WhatsApp Web tab.
import { enforced, getLicense, activate, deactivate, checkStatus, admin as licenseAdmin } from './license.js';
import {
  SYNC_KEYS,
  SYNC_ALARM,
  scheduleAutoPush,
  pollPull,
  syncNow,
  setSyncAlarm,
  setOnRemoteApplied,
  pullAfterActivate
} from './sync.js';

const WA_URL_PATTERN = 'https://web.whatsapp.com/*';
const DEFAULT_SETTINGS = {
  jitterMinutes: 4, // fixed-time schedules fire within +/- this many minutes
  defaultDelayBetweenMsMs: [20000, 45000], // human-ish gap between consecutive sends
  defaultDelayBetweenListsMs: [30000, 60000], // gap before starting the next list in a scheduled send
  consentAccepted: false,
  theme: 'system', // 'system' | 'light' | 'dark'
  masterEnabled: true, // instant kill switch — off blocks new sends and stops any run in progress
  headerText: '', // global default header — prepended to every item's text/caption, unless overridden per-message or per-thread (see resolveHeaderFooter)
  footerText: '', // global default footer — appended to every item's text/caption, unless overridden per-message or per-thread (see resolveHeaderFooter)
  syncEnabled: true, // cloud sync of messages/lists/log/settings under this install's activation key, on by default
  privacyBlur: false, // blurs chat names/avatars/message text on the WhatsApp Web page itself, for screen-sharing/public spaces — see content.js
  // Which parts privacyBlur actually covers, how hard, and what style —
  // right-click the eye button in the header to configure. `style` is
  // global (blur or a solid blackout bar); each category has its own
  // enabled flag and intensity (0-100, see content.js's effectValue for
  // what that maps to). See content.js's PRIVACY_BLUR_RULES for what each
  // category actually targets on the page.
  privacyBlurOptions: {
    style: 'blur', // 'blur' | 'blackout'
    categories: {
      messages: { enabled: true, intensity: 60 },
      media: { enabled: true, intensity: 60 },
      chatListNames: { enabled: true, intensity: 60 },
      chatListPreviews: { enabled: true, intensity: 60 },
      profilePictures: { enabled: true, intensity: 60 }
    }
  },
  uiMode: 'popup' // 'popup' | 'sidepanel' — see applyUiMode below and the header button in popup.js
};

// License heartbeat — re-validates the cached activation key every so often
// so a revoked/expired key (or a device an admin reset) stops working
// within minutes even if the popup is never opened. The popup also triggers
// one check each time it opens.
const LICENSE_HEARTBEAT_ALARM = 'licenseHeartbeat';

// The two alarms that aren't per-schedule. rebuildAllAlarms() below starts
// from chrome.alarms.clearAll(), so these have to be put back every time.
async function ensureBackgroundAlarms() {
  if (enforced()) await chrome.alarms.create(LICENSE_HEARTBEAT_ALARM, { periodInMinutes: 15 });
  const { settings } = await getRunControlState();
  await setSyncAlarm(!!settings.syncEnabled);
}

// One-time cleanup of the previous Google-sign-in/Firebase sync's storage
// keys — harmless if they were never there.
chrome.storage.local.remove(['authUser', 'syncMeta']);

// ---------- storage helpers ----------

// A saved message used to be a single {kind, text, media} — now it's a named
// sequence of items (each independently text, or media with its own
// caption), sent one after another to a chat before moving to the next.
// Older stored messages are normalized to the new shape on read so nothing
// needs a one-time migration step. A message also now carries its own
// `schedules` array (see migrateLegacyCampaignsIntoMessages below) instead
// of scheduling living in a separate top-level "campaigns" entity.
function migrateMessage(m) {
  let next = m;
  if (!Array.isArray(next.items)) {
    const item =
      next.kind === 'media' && next.media
        ? { kind: 'media', media: next.media, caption: next.text || '' }
        : { kind: 'text', text: next.text || '' };
    next = { ...next, items: [item] };
  }
  if (!Array.isArray(next.schedules)) {
    next = { ...next, schedules: [] };
  }
  return next;
}

// Normalizes one legacy campaign's shape (old single-slot schedule fields,
// old delay/separator field names) — used only by the one-time migration
// below, since campaigns as their own stored entity no longer exist.
// Schedules used to have one slot (a single daily time, or a single one-off
// datetime) and a Paced/Fast sendMode; now a schedule can have multiple
// daily times, a repeating interval, or multiple one-off datetimes, and
// delay is either "use the Safety-tab defaults" or fully custom. Whether to
// send a separator between items is also decided per-schedule (and per
// one-off send) rather than baked into the message — older campaigns may
// still have this stored under its old name, sendDivider.
function migrateCampaign(c) {
  let next = c;
  if (next.scheduleType === 'fixed') {
    next = { ...next, scheduleType: 'times', times: next.time ? [next.time] : [] };
  } else if (next.scheduleType === 'once' && next.datetime && !next.datetimes) {
    next = { ...next, datetimes: [next.datetime] };
  }
  if (next.useDefaultDelay === undefined) {
    next = { ...next, useDefaultDelay: !next.delayBetweenMsMs };
  }
  if (next.sendSeparator === undefined) {
    next = { ...next, sendSeparator: next.sendDivider !== undefined ? next.sendDivider : true };
  }
  return next;
}

// One-time migration: folds any legacy top-level `campaigns` entries into
// `schedules` on the message they targeted, then removes the `campaigns`
// key entirely. Safe to call on every startup — it's a no-op once
// `campaigns` no longer exists in storage. A campaign whose target message
// was since deleted has nothing to attach to and is dropped.
async function migrateLegacyCampaignsIntoMessages() {
  const data = await chrome.storage.local.get(['messages', 'campaigns']);
  if (!Array.isArray(data.campaigns)) return;
  const messages = (data.messages || []).map(migrateMessage);
  for (const raw of data.campaigns) {
    const c = migrateCampaign(raw);
    const message = messages.find((m) => m.id === c.messageId);
    if (!message) continue;
    const {
      id,
      messageId,
      name,
      listIds,
      memberFilter,
      itemIndexes,
      sendSeparator,
      scheduleType,
      times,
      datetimes,
      intervalMinutes,
      timesPerDay,
      windowStart,
      windowEnd,
      useDefaultDelay,
      delayBetweenMsMs,
      delayBetweenListsMs,
      enabled
    } = c;
    message.schedules = [
      ...(message.schedules || []),
      {
        id: id || uid(),
        label: name || '',
        listIds,
        memberFilter,
        itemIndexes,
        sendSeparator,
        scheduleType,
        times,
        datetimes,
        intervalMinutes,
        timesPerDay,
        windowStart,
        windowEnd,
        useDefaultDelay,
        delayBetweenMsMs,
        delayBetweenListsMs,
        enabled
      }
    ];
  }
  await chrome.storage.local.set({ messages });
  await chrome.storage.local.remove('campaigns');
}

async function getState() {
  const data = await chrome.storage.local.get([
    'fetchedChats',
    'lists',
    'messages',
    'log',
    'settings',
    'activeRuns',
    'cloudSync'
  ]);
  return {
    fetchedChats: data.fetchedChats || [],
    lists: data.lists || [],
    messages: (data.messages || []).map(migrateMessage),
    log: data.log || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    activeRuns: data.activeRuns || {},
    license: await getLicense(),
    cloudSync: data.cloudSync || {}
  };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
  // Local saves never wait on the network — they're durable the moment
  // chrome.storage.local resolves above. The push is debounced/rate-limited
  // and no-ops instantly if sync is off or this install isn't activated;
  // any failure lands in cloudSync.lastError (shown in the popup's sync
  // row) rather than a toast.
  if (Object.keys(partial).some((key) => SYNC_KEYS.includes(key))) scheduleAutoPush();
}

// getState() reads every storage key at once, including `messages` — which
// can hold multi-MB base64 media data URLs — so it's fine for the popup UI
// but too heavy to call on every single send. These read only the one or
// two small keys the send loop actually touches per item, which is what
// keeps back-to-back sends in the same chat actually instant.
async function getLogOnly() {
  const data = await chrome.storage.local.get(['log']);
  return data.log || [];
}

async function getRunControlState() {
  const data = await chrome.storage.local.get(['settings', 'activeRuns']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    activeRuns: data.activeRuns || {}
  };
}

async function appendLog(entry) {
  const log = await getLogOnly();
  const next = [{ id: crypto.randomUUID(), timestamp: Date.now(), ...entry }, ...log].slice(
    0,
    300
  );
  await setState({ log: next });
}

function uid() {
  return crypto.randomUUID();
}

// Same parsing as page-bridge.js's chatIdFromMsgId — the chat-id segment
// embedded in a WhatsApp message id is ground truth for which chat a
// message actually lives in. Applied again here, at delete time, so a log
// entry whose stored waId predates that fix (an @c.us id for a contact
// WhatsApp actually sent the message to under their @lid identity) still
// gets deleted correctly, not just messages sent after the fix.
function chatIdFromMsgId(msgId) {
  if (typeof msgId !== 'string') return null;
  const parts = msgId.split('_');
  return parts.length >= 2 ? parts[1] : null;
}

// ---------- WhatsApp tab management ----------

async function findWaTab() {
  const tabs = await chrome.tabs.query({ url: WA_URL_PATTERN });
  return tabs[0] || null;
}

async function ensureWaTab() {
  let tab = await findWaTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: false });
    // Give the page real time to boot and render the chat list / QR scan.
    await new Promise((r) => setTimeout(r, 12000));
  }
  return tab;
}

function sendToTab(tabId, message, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Content script did not respond (timeout).')), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function pingContentScript(tabId, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await sendToTab(tabId, { action: 'ping' }, 3000);
      if (res && res.ok) return true;
    } catch (e) {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Best-effort: no WA tab open, or its content script not ready yet, just
// means content.js will pick up the new value itself next time it loads
// (see its own getState call on startup) — not a failure worth surfacing.
async function pushPrivacyBlurToTab(enabled, options) {
  const tab = await findWaTab();
  if (!tab) return;
  try {
    await sendToTab(tab.id, { action: 'setPrivacyBlur', enabled: !!enabled, options }, 3000);
  } catch (_) {}
}

// ---------- country flag cache (for the quick-send number box) ----------
// Flag images for the country-code picker are fetched from flagcdn.com
// exactly once — right after install — then kept as data URLs in
// chrome.storage.local forever after, so the popup never re-downloads them
// on every open. Bump FLAG_CACHE_VERSION to force a one-time refresh (e.g.
// switching CDN/size); ensureFlagCache also self-heals — if the cache was
// cleared or only partially written, it re-downloads just the missing
// entries, not the whole set.
const FLAG_CACHE_VERSION = 1;
const FLAG_ISO_LIST = [
  'AF','AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BY','BE','BZ','BJ','BT',
  'BO','BA','BW','BR','BN','BG','BF','BI','KH','CM','CA','CV','CF','TD','CL','CN','CO','KM','CD','CG',
  'CR','HR','CU','CY','CZ','DK','DJ','DM','DO','EC','EG','SV','GQ','ER','EE','SZ','ET','FJ','FI','FR',
  'GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','HN','HK','HU','IS','IN','ID','IR','IQ',
  'IE','IL','IT','CI','JM','JP','JO','KZ','KE','KI','XK','KW','KG','LA','LV','LB','LS','LR','LY','LI',
  'LT','LU','MO','MG','MW','MY','MV','ML','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ',
  'MM','NA','NR','NP','NL','NZ','NI','NE','NG','KP','MK','NO','OM','PK','PW','PS','PA','PG','PY','PE',
  'PH','PL','PT','QA','RO','RU','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SG','SK',
  'SI','SB','SO','ZA','KR','SS','ES','LK','SD','SR','SE','CH','SY','TW','TJ','TZ','TH','TL','TG','TO',
  'TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','VA','VE','VN','YE','ZM','ZW'
];
async function fetchAsDataUrl(url, mimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${mimeType};base64,${btoa(binary)}`;
}
let flagCacheInFlight = null;
async function ensureFlagCache() {
  // Collapses concurrent callers (onInstalled firing at the same time as a
  // popup's own backfill call) into one download pass instead of two.
  if (flagCacheInFlight) return flagCacheInFlight;
  flagCacheInFlight = (async () => {
    const stored = await chrome.storage.local.get(['flagCache', 'flagCacheVersion']);
    const cache = stored.flagCacheVersion === FLAG_CACHE_VERSION && stored.flagCache ? { ...stored.flagCache } : {};
    const missing = FLAG_ISO_LIST.filter((iso2) => !cache[iso2]);
    if (missing.length === 0) return cache;
    const CONCURRENCY = 8;
    let idx = 0;
    async function worker() {
      while (idx < missing.length) {
        const iso2 = missing[idx++];
        try {
          cache[iso2] = await fetchAsDataUrl(`https://flagcdn.com/w40/${iso2.toLowerCase()}.png`, 'image/png');
        } catch (e) {
          // Left out of the cache — still missing next time ensureFlagCache
          // runs (next popup open / next install event), and the popup's
          // own flagIconHtml() falls back to a plain placeholder swatch for
          // any iso2 not yet cached in the meantime. Not worth surfacing as
          // an error over one flag icon.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
    await chrome.storage.local.set({ flagCache: cache, flagCacheVersion: FLAG_CACHE_VERSION });
    return cache;
  })();
  try {
    return await flagCacheInFlight;
  } finally {
    flagCacheInFlight = null;
  }
}

// Real-time "would a send actually work right now" check for the popup's
// header status dot — a single quick attempt, not pingContentScript's
// patient multi-attempt retry loop (which is fine to wait ~7s for during an
// actual send, but would make the popup feel stuck if run on every open).
// Deliberately doesn't call ensureWaTab() — auto-opening a tab just to
// answer "is it ready" would be surprising, and "no tab open" is itself a
// legitimate not-ready state to report.
async function checkWaStatus() {
  const tab = await findWaTab();
  if (!tab) {
    return { ready: false, reason: 'No WhatsApp Web tab is open.' };
  }
  try {
    const res = await sendToTab(tab.id, { action: 'ping' }, 4000);
    if (res && res.ok) return { ready: true };
    return { ready: false, reason: (res && res.error) || 'WhatsApp Web is not ready yet.' };
  } catch (err) {
    return { ready: false, reason: String((err && err.message) || err) };
  }
}

// ---------- sending ----------

function randomBetween([min, max]) {
  return min + Math.random() * (max - min);
}

// Live progress for a running campaign or "send now", read by the popup via
// STATE.activeRuns (chrome.storage.onChanged already makes the popup
// re-render on every change, so no polling is needed on that end). Keyed by
// campaign id — for an ad-hoc send that's the transient `adhoc-...` id
// generated for that one run, returned to the popup so it can look itself up.
async function startActiveRun(runId, name, total) {
  const { activeRuns } = await getRunControlState();
  const pruned = {};
  for (const [id, run] of Object.entries(activeRuns)) {
    // Sweep out old finished runs opportunistically so storage doesn't
    // accumulate them — no dedicated cleanup job needed.
    if (!run.done || Date.now() - (run.finishedAt || 0) < 60000) pruned[id] = run;
  }
  pruned[runId] = { id: runId, name, total, sent: 0, failed: 0, done: false, startedAt: Date.now() };
  await setState({ activeRuns: pruned });
}

async function bumpActiveRun(runId, field) {
  const { activeRuns } = await getRunControlState();
  const run = activeRuns[runId];
  if (!run) return;
  await setState({ activeRuns: { ...activeRuns, [runId]: { ...run, [field]: run[field] + 1 } } });
}

async function finishActiveRun(runId) {
  const { activeRuns } = await getRunControlState();
  const run = activeRuns[runId];
  if (!run) return;
  await setState({ activeRuns: { ...activeRuns, [runId]: { ...run, done: true, finishedAt: Date.now() } } });
}

// Polled before every send: the master switch stops a run outright (used
// for the "instantly kill" toggle), pausing a specific run just blocks
// until resumed. Re-reads storage each time so an external toggle click
// mid-run is noticed on the next item rather than requiring a restart.
async function waitToProceedOrStop(runId) {
  while (true) {
    const { settings, activeRuns } = await getRunControlState();
    if (!settings.masterEnabled) return 'master-off';
    const run = activeRuns[runId];
    if (!run || run.done) return 'reset'; // Reset button deletes the run — nothing else does mid-run
    if (!run.paused) return 'proceed';
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Sent as its own standalone text message between items/threads in a chat
// (never after the last one, never for a single-item message) so threads
// stay visually separated even though they're sent back-to-back with no
// delay. One line, 3 dashes.
const THREAD_SEPARATOR = '➖➖➖';

// Joins whichever of header/content/footer are non-empty with a blank line
// between each — so a missing header or empty caption never leaves a stray
// leading/trailing blank line.
function withHeaderFooter(content, headerText, footerText) {
  const parts = [];
  if (headerText) parts.push(headerText);
  if (content) parts.push(content);
  if (footerText) parts.push(footerText);
  return parts.join('\n\n');
}

// Header/footer resolve through three layers, each able to opt out of the
// one above it: a thread/item ('default' | 'custom' | 'off') falls back to
// its message ('default' | 'custom' | 'off'), which falls back to the
// global Settings-tab text. 'off' at any layer wins outright — it means
// "no header/footer here", not "fall through". A layer that doesn't apply
// (e.g. an ad-hoc send with no saved message) is treated as 'default' and
// simply skipped.
function resolveHeaderFooter(item, message, settings) {
  const itemMode = item.headerFooterMode || 'default';
  if (itemMode === 'off') return { headerText: '', footerText: '' };
  if (itemMode === 'custom') {
    return { headerText: (item.headerText || '').trim(), footerText: (item.footerText || '').trim() };
  }
  const msgMode = (message && message.headerFooterMode) || 'default';
  if (msgMode === 'off') return { headerText: '', footerText: '' };
  if (msgMode === 'custom') {
    return { headerText: (message.headerText || '').trim(), footerText: (message.footerText || '').trim() };
  }
  return { headerText: (settings.headerText || '').trim(), footerText: (settings.footerText || '').trim() };
}

// Applies the resolved header/footer to every item of a message (text goes
// in .text, media goes in .caption) — a fresh array so the underlying
// stored message/items are never mutated.
function applyHeaderFooter(items, settings, message) {
  return items.map((item) => {
    const { headerText, footerText } = resolveHeaderFooter(item, message, settings);
    if (!headerText && !footerText) return item;
    if (item.kind === 'media') {
      return { ...item, caption: withHeaderFooter(item.caption || '', headerText, footerText) };
    }
    return { ...item, text: withHeaderFooter(item.text || '', headerText, footerText) };
  });
}

// Looks up whichever chat is currently open in the WhatsApp Web tab, for the
// "send to current chat" / "send this item to current chat" flows — shared
// so both callers get the same tab-readiness handling and error messages.
async function resolveActiveChatTarget() {
  const tab = await ensureWaTab();
  const ready = await pingContentScript(tab.id);
  if (!ready) {
    return { ok: false, error: 'WhatsApp Web tab is not ready (make sure you are logged in and the page finished loading).' };
  }
  const chatRes = await sendToTab(tab.id, { action: 'getActiveChat' }, 10000);
  if (!chatRes || !chatRes.ok) {
    return { ok: false, error: (chatRes && chatRes.error) || 'Could not read the currently open chat.' };
  }
  return { ok: true, chat: chatRes.chat };
}

async function sendOneItem(waId, item) {
  const tab = await ensureWaTab();
  const ready = await pingContentScript(tab.id);
  if (!ready) {
    throw new Error(
      'WhatsApp Web tab is not ready (make sure you are logged in / QR code is scanned, and the page finished loading).'
    );
  }
  let res;
  if (item.kind === 'media' && item.media) {
    res = await sendToTab(tab.id, { action: 'sendMedia', waId, media: item.media, caption: item.caption || '' }, 45000);
  } else {
    res = await sendToTab(tab.id, { action: 'sendMessage', waId, text: item.text }, 30000);
  }
  if (!res || !res.ok) {
    throw new Error((res && res.error) || 'Unknown send failure.');
  }
  return res;
}

async function runCampaign(campaign) {
  const { messages, lists, settings } = await getState();
  if (!settings.masterEnabled) {
    await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'Skipped: extension is switched off.' });
    return;
  }
  // A revoked/expired key stops scheduled sends too, not just the popup —
  // otherwise a schedule set up before the key died would keep firing.
  if (!(await getLicense()).activated) {
    await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'Skipped: extension is not activated.' });
    return;
  }
  // A send-without-saving pass items straight through (never persisted as a
  // message), so there's nothing to look up by id — everything else below
  // (targets, pacing, logging, separators) runs exactly the same either way.
  let message = null;
  let items;
  if (Array.isArray(campaign.items)) {
    items = campaign.items;
  } else {
    message = messages.find((m) => m.id === campaign.messageId);
    if (!message) {
      await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'Message no longer exists.' });
      return;
    }
    // Restricts to a chosen subset of the message's items instead of all of
    // them — e.g. unchecking a couple of threads before a list send, or the
    // "send just this one thread to the current chat" flow (a single-index
    // array). Everything else (targets, pacing, logging, separators) runs
    // exactly the same either way, just over fewer items.
    items = Array.isArray(campaign.itemIndexes)
      ? campaign.itemIndexes.map((i) => (message.items || [])[i]).filter(Boolean)
      : message.items || [];
  }
  if (items.length === 0) {
    await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'Message has no content.' });
    return;
  }
  // Header/footer wrap every item/thread individually (text or, for media,
  // caption) — see resolveHeaderFooter for the item→message→global
  // fallback. A send-without-saving has no real message to carry this, so
  // its compose-form setting rides along as messageOverride instead (a
  // plain {headerFooterMode, headerText, footerText}, not a saved message
  // — must stay out of `message` itself, which line ~646 below also uses
  // to decide whether to stamp a real message's lastSentAt).
  const sendItems = applyHeaderFooter(items, settings, message || campaign.messageOverride || null);
  // A one-off "send to whatever chat is open right now" send bypasses saved
  // lists entirely — it's given its single target directly instead of a
  // listId to look up, wrapped as one synthetic list so every loop below
  // (pacing, progress, logging, separators) works unmodified either way.
  let targetLists;
  if (campaign.explicitTargets) {
    targetLists = [{ id: 'explicit', name: campaign.name, members: campaign.explicitTargets }];
  } else {
    // memberFilter optionally restricts a list to a chosen subset of its
    // members for this one send (e.g. unchecking a couple of chats before
    // clicking Send now) rather than always sending to every member of
    // every checked list.
    targetLists = lists
      .filter((l) => campaign.listIds.includes(l.id))
      .map((l) => {
        const allowed = campaign.memberFilter && campaign.memberFilter[l.id];
        return allowed ? { ...l, members: (l.members || []).filter((m) => allowed.includes(m.waId)) } : l;
      })
      .filter((l) => (l.members || []).length > 0);
    if (targetLists.length === 0) {
      await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'No valid lists.' });
      return;
    }
  }

  let totalSent = 0;
  let totalFailed = 0;
  // A separator goes between items, not after the last one — so N items
  // means N-1 separators, and a single-item message gets none at all.
  // Whether to send separators at all is decided per-send
  // (campaign.sendSeparator), not stored on the message — every caller of
  // runCampaign sets this explicitly.
  const separatorsPerTarget = campaign.sendSeparator && items.length > 1 ? items.length - 1 : 0;
  const perTarget = items.length + separatorsPerTarget;
  const totalCount = targetLists.reduce((sum, list) => sum + (list.members || []).length * perTarget, 0);
  await startActiveRun(campaign.id, campaign.name, totalCount);

  let stopped = false;
  let stopReason = null;

  for (let li = 0; li < targetLists.length && !stopped; li++) {
    const list = targetLists[li];
    const targets = list.members || [];

    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      let sentAnyForTarget = false;

      // All items ("threads") of the message go to this one chat back-to-back,
      // with no configured delay between them — the paced delay only applies
      // when moving on to the next chat, below.
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        // Checked before every single send: the master switch (instant kill)
        // or this run being paused both block here, re-reading storage each
        // time so a toggle clicked mid-run takes effect on the very next item
        // instead of needing the whole campaign restarted.
        const outcome = await waitToProceedOrStop(campaign.id);
        if (outcome !== 'proceed') {
          stopped = true;
          stopReason = outcome;
          break;
        }

        const item = sendItems[itemIndex];
        const itemLabel = items.length > 1 ? ` (item ${itemIndex + 1}/${items.length})` : '';
        let itemSent = false;
        try {
          const sendRes = await sendOneItem(target.waId, item);
          itemSent = true;
          sentAnyForTarget = true;
          totalSent++;
          await bumpActiveRun(campaign.id, 'sent');
          await appendLog({
            campaignId: campaign.id,
            campaignName: campaign.name,
            chatName: target.name,
            status: 'success',
            detail: `Sent${itemLabel}: "${(item.text || item.caption || '[media]').slice(0, 60)}"`,
            // Enough to later call "delete for everyone" on this exact
            // message — waId is the chat it actually landed in (can differ
            // from target.waId for a community-redirected send).
            waId: sendRes.waId || target.waId,
            msgId: sendRes.msgId || null
          });
        } catch (err) {
          totalFailed++;
          await bumpActiveRun(campaign.id, 'failed');
          await appendLog({
            campaignId: campaign.id,
            campaignName: campaign.name,
            chatName: target.name,
            status: 'error',
            detail: `${String(err.message || err)}${itemLabel}`
          });
        }

        const needsSeparator = campaign.sendSeparator && itemIndex < items.length - 1;

        // Separator goes right after, as its own message, in the same chat —
        // only between items (never after the last one, never for a
        // single-item message), and skipped if the item itself never went
        // out (nothing to separate).
        if (itemSent && needsSeparator) {
          const pauseCheck = await waitToProceedOrStop(campaign.id);
          if (pauseCheck !== 'proceed') {
            stopped = true;
            stopReason = pauseCheck;
            break;
          }
          try {
            await sendOneItem(target.waId, { kind: 'text', text: THREAD_SEPARATOR });
            totalSent++;
            await bumpActiveRun(campaign.id, 'sent');
          } catch (err) {
            totalFailed++;
            await bumpActiveRun(campaign.id, 'failed');
            await appendLog({
              campaignId: campaign.id,
              campaignName: campaign.name,
              chatName: target.name,
              status: 'error',
              detail: `Separator failed: ${String(err.message || err)}${itemLabel}`
            });
          }
        } else if (!itemSent && needsSeparator) {
          // Item never sent — the progress total still reserved a slot for
          // the separator that won't happen, so mark it done (as a no-op) to
          // keep the bar from stalling short of 100%.
          totalFailed++;
          await bumpActiveRun(campaign.id, 'failed');
        }
      }

      if (stopped) break;

      // Pace before moving to the next chat — not after the last chat in this
      // list, and only if something actually sent to this chat.
      if (sentAnyForTarget && ti < targets.length - 1) {
        const delayRange = campaign.useDefaultDelay ? settings.defaultDelayBetweenMsMs : campaign.delayBetweenMsMs || settings.defaultDelayBetweenMsMs;
        await new Promise((r) => setTimeout(r, randomBetween(delayRange)));
      }
    }

    if (!stopped && li < targetLists.length - 1) {
      const delayRange = campaign.useDefaultDelay ? settings.defaultDelayBetweenListsMs : campaign.delayBetweenListsMs || settings.defaultDelayBetweenListsMs;
      await new Promise((r) => setTimeout(r, randomBetween(delayRange)));
    }
  }

  if (stopped) {
    await appendLog({
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: 'error',
      detail: stopReason === 'master-off' ? 'Stopped: extension switched off mid-run.' : 'Stopped: run was reset.'
    });
  }

  if (message) {
    await setState({
      messages: messages.map((m) => (m.id === message.id ? { ...m, lastSentAt: Date.now() } : m))
    });
  }
  await finishActiveRun(campaign.id);

  chrome.notifications.create(uid(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'WhatsApp Scheduler',
    message: `Campaign "${campaign.name}" ${stopped ? 'stopped' : 'finished'}: ${totalSent} sent, ${totalFailed} failed.`
  });
}

// ---------- auto-reply (incoming message -> matching saved message) ----------
function autoReplyTriggerMatches(text, trigger) {
  if (!trigger || !trigger.value) return false;
  if (trigger.type === 'regex') {
    try {
      return new RegExp(trigger.value, trigger.caseSensitive ? '' : 'i').test(text);
    } catch (_) {
      return false; // an invalid regex just never matches, rather than throwing on every incoming message
    }
  }
  const hay = trigger.caseSensitive ? text : text.toLowerCase();
  const needle = trigger.caseSensitive ? trigger.value : trigger.value.toLowerCase();
  return hay.includes(needle);
}

const AUTO_REPLY_COOLDOWN_UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000 };

// Fired for every real incoming message (page-bridge.js's chat.new_message
// hook, relayed through content.js) — checked against every saved
// message's autoReply rules. Reuses runCampaign (the same engine behind
// "send to current chat") with a single explicit target, so header/footer
// resolution, license/master-switch gating and logging all stay in one
// place instead of a second copy of send logic.
async function handleIncomingMessage({ chatId, text }) {
  if (!chatId || !text) return;
  const { messages, settings, fetchedChats } = await getState();
  if (!settings.masterEnabled) return;
  const candidates = messages.filter(
    (m) => m.autoReply && m.autoReply.enabled && (m.autoReply.triggers || []).some((t) => autoReplyTriggerMatches(text, t))
  );
  if (candidates.length === 0) return;
  const chatName = (fetchedChats.find((c) => c.waId === chatId) || {}).name || chatId;
  // Cooldown state is deliberately its own untracked chrome.storage.local
  // key, not part of getState()/SYNC_KEYS — it's pure rate-limiting
  // bookkeeping, not real data, so it shouldn't sync across devices or
  // bloat the cloud snapshot.
  const { autoReplyCooldowns } = await chrome.storage.local.get(['autoReplyCooldowns']);
  const cooldowns = autoReplyCooldowns || {};
  let cooldownsChanged = false;
  for (const message of candidates) {
    const ar = message.autoReply;
    const cooldownMs = ar.cooldownEnabled
      ? (ar.cooldownValue || 0) * (AUTO_REPLY_COOLDOWN_UNIT_MS[ar.cooldownUnit] || AUTO_REPLY_COOLDOWN_UNIT_MS.minutes)
      : 0;
    if (cooldownMs > 0) {
      const last = (cooldowns[message.id] || {})[chatId] || 0;
      if (Date.now() - last < cooldownMs) continue;
      // Marked BEFORE sending, not after — several matching messages can
      // arrive faster than one send round-trips, and this is what stops
      // that burst from firing more than one reply.
      cooldowns[message.id] = { ...(cooldowns[message.id] || {}), [chatId]: Date.now() };
      cooldownsChanged = true;
    }
    await runCampaign({
      id: `autoreply-${message.id}-${Date.now()}`,
      name: `Auto-reply: ${message.name}`,
      messageId: message.id,
      explicitTargets: [{ waId: chatId, name: chatName }],
      sendSeparator: false
    });
  }
  if (cooldownsChanged) await chrome.storage.local.set({ autoReplyCooldowns: cooldowns });
}

async function markLogEntryDeleted(id) {
  const log = await getLogOnly();
  const next = log.map((l) => (l.id === id ? { ...l, deletedForEveryone: true } : l));
  await setState({ log: next });
}

// "Delete for everyone" for one or more previously-sent log entries — reuses
// the same activeRuns progress/pause/reset machinery as a normal send, just
// calling WPP.chat.deleteMessage(..., revoke: true) instead of a send. Each
// entry is attempted independently: WhatsApp only allows this within a
// limited time window after sending, so a failure on one message (too old,
// already deleted elsewhere, etc.) is logged and the rest still proceed
// rather than aborting the whole batch.
//
// This deliberately does one message per call, one at a time, with a real
// pacing gap between every single one — not grouped/batched by chat. That
// was tried (WPP.chat.deleteMessage() accepts an array of message ids) on
// the assumption it'd send one combined command per chat; decompiling the
// actual implementation showed it just loops internally and fires one
// revoke per message anyway, with *no* pacing between them, which turned
// out to be *less* reliable than pacing them ourselves.
async function runDeleteForEveryone(runId, entries) {
  const { settings } = await getRunControlState();
  const label = entries.length > 1 ? `Delete for everyone (${entries.length} messages)` : 'Delete for everyone';
  if (!settings.masterEnabled) {
    await appendLog({ campaignId: runId, campaignName: label, status: 'error', detail: 'Skipped: extension is switched off.' });
    return;
  }
  await startActiveRun(runId, label, entries.length);
  let stopped = false;
  let stopReason = null;
  for (const entry of entries) {
    const outcome = await waitToProceedOrStop(runId);
    if (outcome !== 'proceed') {
      stopped = true;
      stopReason = outcome;
      break;
    }
    try {
      const tab = await ensureWaTab();
      const ready = await pingContentScript(tab.id);
      if (!ready) throw new Error('WhatsApp Web tab is not ready.');
      const waId = chatIdFromMsgId(entry.msgId) || entry.waId;
      const res = await sendToTab(tab.id, { action: 'deleteMessage', waId, msgId: entry.msgId }, 20000);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Unknown failure.');
      if (!res.isRevoked) throw new Error('WhatsApp declined to delete for everyone (likely past its time window, or already removed).');
      // No separate "success" log entry — the original Sent entry already
      // gets its delete button replaced with a "Deleted for everyone ✓"
      // mark (see markLogEntryDeleted/renderLog), which is confirmation
      // enough without duplicating it as a second log line.
      await markLogEntryDeleted(entry.id);
      await bumpActiveRun(runId, 'sent');
    } catch (err) {
      await bumpActiveRun(runId, 'failed');
      await appendLog({
        campaignId: runId,
        campaignName: label,
        chatName: entry.chatName,
        status: 'error',
        detail: `Could not delete for everyone in ${entry.chatName || 'chat'}: ${String(err.message || err)}`
      });
    }
    // Pacing gap between deletes — same spirit as sends, avoids firing a
    // burst of revoke calls back-to-back faster than WhatsApp Web's own
    // connection can keep up with (a plausible cause of a delete silently
    // not actually landing despite resolving locally).
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (stopped) {
    await appendLog({
      campaignId: runId,
      campaignName: label,
      status: 'error',
      detail: stopReason === 'master-off' ? 'Stopped: extension switched off mid-run.' : 'Stopped: run was reset.'
    });
  }
  await finishActiveRun(runId);
}

// ---------- alarm scheduling ----------
// A message can carry several schedules (each targeting its own list(s) and
// timing). A schedule's timing is one of:
//   'times'    — one or more daily HH:MM times (e.g. 9am, 1pm, 6pm) — each
//                gets its own recurring alarm, individually rescheduled for
//                the next day right after it fires.
//   'interval' — repeats every N minutes via chrome.alarms' native
//                periodInMinutes, optionally only within a daily active-hours
//                window (checked when the alarm fires, since the alarms API
//                itself has no notion of "only between 9am and 9pm").
//   'once'     — one or more specific one-off datetimes; each fires once and
//                is then tombstoned (set to null, keeping array indices
//                stable for any other still-pending entries).
// Alarm names are `${kind}:${messageId}:${scheduleId}[:${idx}]` so an alarm
// firing can be traced straight back to the message + schedule that owns it.

function alarmIdForTime(messageId, scheduleId, idx) {
  return `times:${messageId}:${scheduleId}:${idx}`;
}
function alarmIdForInterval(messageId, scheduleId) {
  return `interval:${messageId}:${scheduleId}`;
}
function alarmIdForOnce(messageId, scheduleId, idx) {
  return `once:${messageId}:${scheduleId}:${idx}`;
}

function scheduleDisplayName(message, schedule) {
  return schedule.label ? `${message.name} — ${schedule.label}` : message.name;
}

function nextDailyTimeMs(hhmm, jitterMinutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const jitterMs = (Math.random() * 2 - 1) * jitterMinutes * 60000;
  return target.getTime() + jitterMs;
}

// Does "now" fall inside the schedule's active-hours window? A window
// wrapping past midnight (e.g. 22:00–06:00) is handled too. No window
// configured means "always active".
function isWithinActiveWindow(schedule) {
  if (!schedule.windowStart || !schedule.windowEnd) return true;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = schedule.windowStart.split(':').map(Number);
  const [eh, em] = schedule.windowEnd.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  if (startMinutes <= endMinutes) return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

async function clearScheduleAlarms(messageId, scheduleId) {
  const all = await chrome.alarms.getAll();
  await Promise.all(
    all
      .filter((a) => {
        const parts = a.name.split(':');
        return parts[1] === messageId && parts[2] === scheduleId;
      })
      .map((a) => chrome.alarms.clear(a.name))
  );
}

async function clearAllAlarmsForMessage(messageId) {
  const all = await chrome.alarms.getAll();
  await Promise.all(
    all.filter((a) => a.name.split(':')[1] === messageId).map((a) => chrome.alarms.clear(a.name))
  );
}

async function scheduleMessageAlarm(messageId, schedule) {
  const { settings } = await getState();
  await clearScheduleAlarms(messageId, schedule.id);
  if (!schedule.enabled) return;

  if (schedule.scheduleType === 'times') {
    (schedule.times || []).forEach((time, idx) => {
      const when = nextDailyTimeMs(time, settings.jitterMinutes);
      chrome.alarms.create(alarmIdForTime(messageId, schedule.id, idx), { when });
    });
  } else if (schedule.scheduleType === 'interval') {
    const periodInMinutes = Math.max(1, Math.round(schedule.intervalMinutes) || 60);
    chrome.alarms.create(alarmIdForInterval(messageId, schedule.id), { delayInMinutes: periodInMinutes, periodInMinutes });
  } else if (schedule.scheduleType === 'once') {
    (schedule.datetimes || []).forEach((dt, idx) => {
      if (!dt) return; // tombstoned (already fired)
      const when = new Date(dt).getTime();
      if (when > Date.now()) {
        chrome.alarms.create(alarmIdForOnce(messageId, schedule.id, idx), { when });
      }
    });
  }
}

async function rebuildAllAlarms() {
  await migrateLegacyCampaignsIntoMessages();
  await chrome.alarms.clearAll();
  await ensureBackgroundAlarms();
  const { messages } = await getState();
  for (const message of messages) {
    for (const schedule of message.schedules || []) {
      if (schedule.enabled) await scheduleMessageAlarm(message.id, schedule);
    }
  }
}
// A pulled snapshot can carry schedules made on another device — they need
// alarms here too. (Both devices then fire them; see README's sync notes.)
setOnRemoteApplied(rebuildAllAlarms);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) {
    await pollPull(false);
    return;
  }
  if (alarm.name === LICENSE_HEARTBEAT_ALARM) {
    await checkStatus();
    return;
  }
  const { messages } = await getState();
  const [kind, messageId, scheduleId, idxStr] = alarm.name.split(':');
  const message = messages.find((m) => m.id === messageId);
  const schedule = message && (message.schedules || []).find((s) => s.id === scheduleId);
  if (!message || !schedule) return;

  if (kind === 'interval' && !isWithinActiveWindow(schedule)) {
    return; // outside the configured hours — the alarm just fires again next period
  }

  await runCampaign({ ...schedule, id: `${message.id}:${schedule.id}`, messageId: message.id, name: scheduleDisplayName(message, schedule) });

  if (kind === 'times') {
    const idx = Number(idxStr);
    const time = (schedule.times || [])[idx];
    if (time) {
      const { settings } = await getState();
      chrome.alarms.create(alarmIdForTime(message.id, schedule.id, idx), { when: nextDailyTimeMs(time, settings.jitterMinutes) });
    }
  } else if (kind === 'once') {
    const idx = Number(idxStr);
    const { messages: current } = await getState();
    const updated = current.map((m) => {
      if (m.id !== message.id) return m;
      const schedules = (m.schedules || []).map((s) => {
        if (s.id !== schedule.id) return s;
        const datetimes = (s.datetimes || []).slice();
        datetimes[idx] = null; // tombstone — keeps other pending entries' indices stable
        const stillPending = datetimes.some(Boolean);
        return { ...s, datetimes, enabled: stillPending, lastRun: Date.now() };
      });
      return { ...m, schedules };
    });
    await setState({ messages: updated });
  }
  // 'interval' alarms repeat on their own via periodInMinutes — nothing to reschedule.
});

// Side panel mode — chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:
// true}) hands the toolbar icon AND any keyboard shortcut bound to
// "Activate the extension" entirely over to Chrome's own native side-panel
// open/close toggle — no onClicked listener, no manually tracking whether
// it's currently open, needed at all. (An earlier version of this tried to
// build that toggle by hand with chrome.windows.create/remove, having
// wrongly assumed chrome.sidePanel had no way to close itself — it does,
// just not through a JS method; this flag is the real mechanism.) Re-applied
// on every install/startup too, not just when the setting changes, since
// this is runtime action state rather than something guaranteed to survive
// a browser restart on its own.
async function applyUiMode(mode) {
  try {
    if (mode === 'sidepanel') {
      await chrome.action.setPopup({ popup: '' });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: 'popup.html' });
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async () => {
  rebuildAllAlarms();
  ensureFlagCache(); // one-time (or self-healing) flag download — see its own comment above
  const { settings } = await getState();
  await applyUiMode(settings.uiMode);
});
chrome.runtime.onStartup.addListener(async () => {
  rebuildAllAlarms();
  const { settings } = await getState();
  await applyUiMode(settings.uiMode);
});

// Keyboard shortcut for privacy blur (default Alt+Shift+X, see manifest.json
// "commands") — Chrome owns the actual key capture and remapping UI for
// this (chrome://extensions/shortcuts), an extension can't build its own
// "press keys to record a hotkey" control that writes to that registry.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-privacy-blur') return;
  const { settings } = await getState();
  const next = !settings.privacyBlur;
  await setState({ settings: { ...settings, privacyBlur: next } });
  await pushPrivacyBlurToTab(next, settings.privacyBlurOptions);
});

// ---------- messages from popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'getState': {
          sendResponse({ ok: true, state: await getState() });
          break;
        }

        case 'checkWaStatus': {
          sendResponse({ ok: true, ...(await checkWaStatus()) });
          break;
        }

        // ---- fetching chats ----
        case 'listOpenChats': {
          const tab = await findWaTab();
          if (!tab) {
            sendResponse({ ok: false, error: 'Open web.whatsapp.com in a tab first, then try again.' });
            break;
          }
          const ready = await pingContentScript(tab.id, 2);
          if (!ready) {
            sendResponse({ ok: false, error: 'WhatsApp Web tab is not ready yet.' });
            break;
          }
          const res = await sendToTab(
            tab.id,
            { action: 'listChats', scope: msg.scope, contactFilter: msg.contactFilter },
            25000
          );
          sendResponse(res);
          break;
        }
        case 'findContactByNumber': {
          const tab = await findWaTab();
          if (!tab) {
            sendResponse({ ok: false, error: 'Open web.whatsapp.com in a tab first, then try again.' });
            break;
          }
          const ready = await pingContentScript(tab.id, 2);
          if (!ready) {
            sendResponse({ ok: false, error: 'WhatsApp Web tab is not ready yet.' });
            break;
          }
          const res = await sendToTab(tab.id, { action: 'findContactByNumber', number: msg.number }, 15000);
          sendResponse(res);
          break;
        }

        case 'getGroupAdminInfo': {
          const tab = await findWaTab();
          if (!tab) {
            sendResponse({ ok: false, error: 'Open web.whatsapp.com in a tab first, then try again.' });
            break;
          }
          const ready = await pingContentScript(tab.id, 2);
          if (!ready) {
            sendResponse({ ok: false, error: 'WhatsApp Web tab is not ready yet.' });
            break;
          }
          const res = await sendToTab(tab.id, { action: 'getGroupAdminInfo', waIds: msg.waIds }, 90000);
          sendResponse(res);
          break;
        }

        // Group & Contact Extractor — the group's actual WhatsApp member
        // list, not a saved list's contents.
        case 'getGroupMembers': {
          const tab = await findWaTab();
          if (!tab) {
            sendResponse({ ok: false, error: 'Open web.whatsapp.com in a tab first, then try again.' });
            break;
          }
          const ready = await pingContentScript(tab.id, 2);
          if (!ready) {
            sendResponse({ ok: false, error: 'WhatsApp Web tab is not ready yet.' });
            break;
          }
          const res = await sendToTab(tab.id, { action: 'getGroupMembers', waId: msg.waId }, 30000);
          sendResponse(res);
          break;
        }

        // ---- fetched chats persist (until explicitly cleared) so a popup
        // close/reopen doesn't lose a scan you haven't saved into a list yet ----
        case 'saveFetchedChats': {
          const { fetchedChats } = await getState();
          const byId = new Map(fetchedChats.map((c) => [c.waId, c]));
          for (const c of msg.chats || []) {
            if (c.waId) byId.set(c.waId, c); // overwrite so name/number/type stay current
          }
          await setState({ fetchedChats: Array.from(byId.values()) });
          sendResponse({ ok: true });
          break;
        }
        case 'clearFetchedChats': {
          await setState({ fetchedChats: [] });
          sendResponse({ ok: true });
          break;
        }

        // ---- lists ----
        case 'saveList': {
          const { lists } = await getState();
          const existingIdx = lists.findIndex((l) => l.id === msg.list.id);
          const now = Date.now();
          let next;
          if (existingIdx >= 0) {
            next = lists.slice();
            next[existingIdx] = { ...next[existingIdx], ...msg.list, updatedAt: now };
          } else {
            next = [...lists, { ...msg.list, id: msg.list.id || uid(), createdAt: now, updatedAt: now }];
          }
          await setState({ lists: next });
          sendResponse({ ok: true });
          break;
        }
        case 'deleteList': {
          const { lists, messages } = await getState();
          sendResponse({
            ok: true,
            usedBySchedules: messages.flatMap((m) =>
              (m.schedules || [])
                .filter((s) => (s.listIds || []).includes(msg.id))
                .map((s) => scheduleDisplayName(m, s))
            )
          });
          await setState({
            lists: lists.filter((l) => l.id !== msg.id),
            messages: messages.map((m) => ({
              ...m,
              schedules: (m.schedules || []).map((s) => ({ ...s, listIds: (s.listIds || []).filter((id) => id !== msg.id) }))
            }))
          });
          break;
        }

        // ---- messages (library) ----
        case 'saveMessage': {
          const { messages } = await getState();
          const existingIdx = messages.findIndex((m) => m.id === msg.message.id);
          let next;
          if (existingIdx >= 0) {
            next = messages.slice();
            next[existingIdx] = { ...next[existingIdx], ...msg.message };
          } else {
            next = [...messages, { ...msg.message, id: msg.message.id || uid(), createdAt: Date.now(), lastSentAt: null }];
          }
          await setState({ messages: next });
          sendResponse({ ok: true });
          break;
        }
        case 'deleteMessage': {
          const { messages } = await getState();
          const message = messages.find((m) => m.id === msg.id);
          if (message) await clearAllAlarmsForMessage(message.id);
          await setState({ messages: messages.filter((m) => m.id !== msg.id) });
          sendResponse({ ok: true });
          break;
        }

        // ---- auto-reply (incoming message -> saved message, see content.js/page-bridge.js) ----
        // No response is actually needed by content.js (it fires and
        // forgets), so this responds immediately and lets the actual
        // matching/sending happen after — a slow WhatsApp send shouldn't
        // hold the content script's sendMessage promise open.
        case 'incomingMessage': {
          sendResponse({ ok: true });
          handleIncomingMessage(msg).catch(() => {});
          break;
        }

        // ---- schedules (per-message auto-send timing) ----
        case 'saveSchedule': {
          const { messages } = await getState();
          const message = messages.find((m) => m.id === msg.messageId);
          if (!message) {
            sendResponse({ ok: false, error: 'Message not found.' });
            break;
          }
          const schedules = message.schedules || [];
          const existingIdx = schedules.findIndex((s) => s.id === msg.schedule.id);
          const schedule = { ...msg.schedule, id: msg.schedule.id || uid() };
          const nextSchedules =
            existingIdx >= 0 ? schedules.map((s, i) => (i === existingIdx ? schedule : s)) : [...schedules, schedule];
          const nextMessages = messages.map((m) => (m.id === message.id ? { ...m, schedules: nextSchedules } : m));
          await setState({ messages: nextMessages });
          await scheduleMessageAlarm(message.id, schedule);
          sendResponse({ ok: true, scheduleId: schedule.id });
          break;
        }
        case 'deleteSchedule': {
          const { messages } = await getState();
          await clearScheduleAlarms(msg.messageId, msg.scheduleId);
          const nextMessages = messages.map((m) =>
            m.id === msg.messageId ? { ...m, schedules: (m.schedules || []).filter((s) => s.id !== msg.scheduleId) } : m
          );
          await setState({ messages: nextMessages });
          sendResponse({ ok: true });
          break;
        }
        case 'toggleSchedule': {
          const { messages } = await getState();
          let toggled = null;
          const nextMessages = messages.map((m) => {
            if (m.id !== msg.messageId) return m;
            const schedules = (m.schedules || []).map((s) => {
              if (s.id !== msg.scheduleId) return s;
              toggled = { ...s, enabled: msg.enabled };
              return toggled;
            });
            return { ...m, schedules };
          });
          await setState({ messages: nextMessages });
          // scheduleMessageAlarm always clears existing alarms first, then
          // reschedules only if enabled — covers both toggle directions.
          if (toggled) await scheduleMessageAlarm(msg.messageId, toggled);
          sendResponse({ ok: true });
          break;
        }
        case 'runScheduleNow': {
          const { messages, settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const message = messages.find((m) => m.id === msg.messageId);
          const schedule = message && (message.schedules || []).find((s) => s.id === msg.scheduleId);
          if (!schedule) {
            sendResponse({ ok: false, error: 'Schedule not found.' });
            break;
          }
          runCampaign({ ...schedule, id: `${message.id}:${schedule.id}`, messageId: message.id, name: scheduleDisplayName(message, schedule) }); // fire and forget; log will update
          sendResponse({ ok: true });
          break;
        }

        // One-off send from the Messages tab — reuses runCampaign with a
        // transient, unpersisted campaign object so it gets the same
        // delay/logging/notification behavior without being saved/scheduled.
        case 'sendNow': {
          const { messages, settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const message = messages.find((m) => m.id === msg.messageId);
          if (!message) {
            sendResponse({ ok: false, error: 'Message not found.' });
            break;
          }
          if (!msg.listIds || msg.listIds.length === 0) {
            sendResponse({ ok: false, error: 'Pick at least one list.' });
            break;
          }
          if (Array.isArray(msg.itemIndexes) && msg.itemIndexes.length === 0) {
            sendResponse({ ok: false, error: 'Select at least one item to send.' });
            break;
          }
          if (
            msg.memberFilter &&
            msg.listIds.every((id) => Array.isArray(msg.memberFilter[id]) && msg.memberFilter[id].length === 0)
          ) {
            sendResponse({ ok: false, error: 'Select at least one chat to send to.' });
            break;
          }
          const runId = `adhoc-${uid()}`;
          runCampaign({
            id: runId,
            name: `Manual send: ${message.name}`,
            messageId: message.id,
            listIds: msg.listIds,
            memberFilter: msg.memberFilter,
            itemIndexes: msg.itemIndexes,
            sendSeparator: msg.sendSeparator !== false,
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true, runId });
          break;
        }

        // Send-without-saving from the Messages tab compose form — same as
        // sendNow above, except the items being sent are never persisted as
        // a saved message; they're passed straight through to runCampaign
        // (see its `campaign.items` branch).
        case 'sendNowAdhoc': {
          const { settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            sendResponse({ ok: false, error: 'Add at least one text or attachment item first.' });
            break;
          }
          if (!msg.listIds || msg.listIds.length === 0) {
            sendResponse({ ok: false, error: 'Pick at least one list.' });
            break;
          }
          if (
            msg.memberFilter &&
            msg.listIds.every((id) => Array.isArray(msg.memberFilter[id]) && msg.memberFilter[id].length === 0)
          ) {
            sendResponse({ ok: false, error: 'Select at least one chat to send to.' });
            break;
          }
          const runId = `adhoc-${uid()}`;
          runCampaign({
            id: runId,
            name: 'One-off send (not saved)',
            items: msg.items,
            messageOverride: msg.messageOverride,
            listIds: msg.listIds,
            memberFilter: msg.memberFilter,
            sendSeparator: msg.sendSeparator !== false,
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true, runId });
          break;
        }

        // Sends to whichever chat is currently open in the WhatsApp Web tab,
        // bypassing saved lists entirely — reuses runCampaign via a single
        // explicit target so it still gets progress/logging/separators/pacing.
        case 'sendNowActiveChat': {
          const { messages, settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const message = messages.find((m) => m.id === msg.messageId);
          if (!message) {
            sendResponse({ ok: false, error: 'Message not found.' });
            break;
          }
          if (Array.isArray(msg.itemIndexes) && msg.itemIndexes.length === 0) {
            sendResponse({ ok: false, error: 'Select at least one item to send.' });
            break;
          }
          const active = await resolveActiveChatTarget();
          if (!active.ok) {
            sendResponse(active);
            break;
          }
          const chat = active.chat;
          const runId = `adhoc-${uid()}`;
          runCampaign({
            id: runId,
            name: `Manual send: ${message.name} (current chat: ${chat.name})`,
            messageId: message.id,
            itemIndexes: msg.itemIndexes,
            explicitTargets: [{ waId: chat.waId, name: chat.name }],
            sendSeparator: msg.sendSeparator !== false,
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true, runId, chatName: chat.name });
          break;
        }

        // Same as sendNowActiveChat but restricted to one item/thread out of
        // the message — for sending just one image or one text of a
        // multi-item message to the currently open chat.
        case 'sendItemToActiveChat': {
          const { messages, settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const message = messages.find((m) => m.id === msg.messageId);
          if (!message) {
            sendResponse({ ok: false, error: 'Message not found.' });
            break;
          }
          if (!(message.items || [])[msg.itemIndex]) {
            sendResponse({ ok: false, error: 'That item no longer exists on this message.' });
            break;
          }
          const active = await resolveActiveChatTarget();
          if (!active.ok) {
            sendResponse(active);
            break;
          }
          const chat = active.chat;
          const runId = `adhoc-${uid()}`;
          runCampaign({
            id: runId,
            name: `Manual send: ${message.name} item ${msg.itemIndex + 1} (current chat: ${chat.name})`,
            messageId: message.id,
            itemIndexes: [msg.itemIndex],
            explicitTargets: [{ waId: chat.waId, name: chat.name }],
            sendSeparator: true, // a single item never actually gets a separator — this is a no-op either way
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true, runId, chatName: chat.name });
          break;
        }

        // Quick send — sends straight to a typed phone number, bypassing
        // saved lists and the currently-open chat entirely. Resolves the
        // number to a real WhatsApp chat first (same lookup the Lists tab's
        // manual-add box uses) so a bad/non-WhatsApp number comes back as a
        // clear error instead of silently no-opping.
        case 'sendNowToNumber': {
          const { settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          if (!msg.number || !String(msg.number).trim()) {
            sendResponse({ ok: false, error: 'Enter a phone number first.' });
            break;
          }
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            sendResponse({ ok: false, error: 'Add at least one text or attachment first.' });
            break;
          }
          const tab = await findWaTab();
          if (!tab) {
            sendResponse({ ok: false, error: 'Open web.whatsapp.com in a tab first, then try again.' });
            break;
          }
          const ready = await pingContentScript(tab.id, 2);
          if (!ready) {
            sendResponse({ ok: false, error: 'WhatsApp Web tab is not ready yet.' });
            break;
          }
          const found = await sendToTab(tab.id, { action: 'findContactByNumber', number: msg.number }, 15000);
          if (!found.ok) {
            sendResponse(found);
            break;
          }
          const runId = `adhoc-${uid()}`;
          runCampaign({
            id: runId,
            name: `Manual send: quick send to ${found.contact.name}`,
            items: msg.items,
            messageOverride: msg.messageOverride,
            explicitTargets: [{ waId: found.contact.waId, name: found.contact.name }],
            sendSeparator: msg.sendSeparator !== false,
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true, runId, chatName: found.contact.name });
          break;
        }

        // Quick send to a chat picked from the quick-send box's own name
        // search (popup.js resolves the name → waId live against WhatsApp
        // itself first, see fetchLiveChatMap) — no number/country-code
        // resolution needed here at all, unlike sendNowToNumber above; a
        // group has no phone number to build one from in the first place.
        case 'sendNowToChat': {
          const { settings } = await getState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          if (!msg.waId) {
            sendResponse({ ok: false, error: 'No chat selected.' });
            break;
          }
          if (!Array.isArray(msg.items) || msg.items.length === 0) {
            sendResponse({ ok: false, error: 'Add at least one text or attachment first.' });
            break;
          }
          const runId = `adhoc-${uid()}`;
          runCampaign({
            id: runId,
            name: `Manual send: quick send to ${msg.name || msg.waId}`,
            items: msg.items,
            messageOverride: msg.messageOverride,
            explicitTargets: [{ waId: msg.waId, name: msg.name || msg.waId }],
            sendSeparator: msg.sendSeparator !== false,
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true, runId, chatName: msg.name || msg.waId });
          break;
        }

        // Popup-side safety net for the flag cache — normally a no-op fast
        // path (already downloaded at install time), only actually fetches
        // anything if the cache was cleared/partial, and only the missing
        // entries even then. See ensureFlagCache above.
        case 'ensureFlagsCached': {
          const cache = await ensureFlagCache();
          sendResponse({ ok: true, cache });
          break;
        }

        case 'clearLog': {
          await setState({ log: [] });
          sendResponse({ ok: true });
          break;
        }

        case 'deleteForEveryone': {
          const { settings } = await getRunControlState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const log = await getLogOnly();
          const entry = log.find((l) => l.id === msg.logId);
          if (!entry || entry.status !== 'success' || !entry.waId || !entry.msgId) {
            sendResponse({ ok: false, error: 'Nothing to delete for this entry.' });
            break;
          }
          if (entry.deletedForEveryone) {
            sendResponse({ ok: false, error: 'Already deleted for everyone.' });
            break;
          }
          const runId = `delete-${uid()}`;
          runDeleteForEveryone(runId, [entry]);
          sendResponse({ ok: true, runId });
          break;
        }

        // Deletes every not-yet-deleted, successfully-sent message logged
        // under one send action (campaignId) — the bulk "undo this whole
        // send" for an ad-hoc send, whose campaignId is unique per click of
        // Send now/send-to-current-chat.
        case 'deleteForEveryoneBulk': {
          const { settings } = await getRunControlState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const log = await getLogOnly();
          const entries = log.filter(
            (l) => l.campaignId === msg.campaignId && l.status === 'success' && l.waId && l.msgId && !l.deletedForEveryone
          );
          if (entries.length === 0) {
            sendResponse({ ok: false, error: 'Nothing left to delete for this send.' });
            break;
          }
          const runId = `delete-${uid()}`;
          runDeleteForEveryone(runId, entries);
          sendResponse({ ok: true, runId });
          break;
        }

        // Same as deleteForEveryoneBulk, but targets an explicit set of log
        // entries rather than "everything under one send" — used when the
        // Log tab's search/status filter is narrowing what's shown, so bulk
        // delete only touches what's actually visible/filtered rather than
        // the whole send it came from.
        case 'deleteForEveryoneByIds': {
          const { settings } = await getRunControlState();
          if (!settings.masterEnabled) {
            sendResponse({ ok: false, error: 'Extension is switched off — turn it back on in the header first.' });
            break;
          }
          const log = await getLogOnly();
          const idSet = new Set(msg.logIds || []);
          const entries = log.filter((l) => idSet.has(l.id) && l.status === 'success' && l.waId && l.msgId && !l.deletedForEveryone);
          if (entries.length === 0) {
            sendResponse({ ok: false, error: 'Nothing left to delete for this filter.' });
            break;
          }
          const runId = `delete-${uid()}`;
          runDeleteForEveryone(runId, entries);
          sendResponse({ ok: true, runId });
          break;
        }

        case 'togglePauseRun': {
          const { activeRuns } = await getState();
          const run = activeRuns[msg.runId];
          if (!run || run.done) {
            sendResponse({ ok: false, error: 'That run is no longer active.' });
            break;
          }
          await setState({ activeRuns: { ...activeRuns, [msg.runId]: { ...run, paused: !run.paused } } });
          sendResponse({ ok: true });
          break;
        }

        // Abandons a stuck/unwanted run (typically one paused mid-way) —
        // deletes its progress record outright, which waitToProceedOrStop
        // notices on the run's very next queued item and stops there. This
        // does not re-send to chats it already reached, it just stops
        // sending to the rest and clears the progress bar.
        case 'resetRun': {
          const { activeRuns } = await getState();
          const next = { ...activeRuns };
          delete next[msg.runId];
          await setState({ activeRuns: next });
          sendResponse({ ok: true });
          break;
        }

        case 'saveSettings': {
          const { settings } = await getState();
          const wasSyncEnabled = settings.syncEnabled;
          const wasPrivacyBlur = settings.privacyBlur;
          const wasPrivacyBlurOptions = JSON.stringify(settings.privacyBlurOptions);
          const wasUiMode = settings.uiMode;
          const nextSettings = { ...settings, ...msg.settings };
          await setState({ settings: nextSettings });
          // Flipping the toggle takes effect immediately rather than waiting
          // for the next service worker wake — turning it on pulls first
          // (so a new device joining a key doesn't overwrite the cloud copy
          // with its own local state) and starts the 1-minute poll; turning
          // it off stops polling right away.
          if (nextSettings.syncEnabled !== wasSyncEnabled) {
            await setSyncAlarm(!!nextSettings.syncEnabled);
            if (nextSettings.syncEnabled) await pollPull(true);
          }
          // Privacy blur lives on the WhatsApp Web page itself (content.js
          // toggles a class there), not in this popup — content.js also
          // reads it fresh via getState on its own load, but pushing it
          // live here means flipping the toggle takes effect on an
          // already-open tab immediately instead of needing a reload.
          if (nextSettings.privacyBlur !== wasPrivacyBlur || JSON.stringify(nextSettings.privacyBlurOptions) !== wasPrivacyBlurOptions) {
            await pushPrivacyBlurToTab(nextSettings.privacyBlur, nextSettings.privacyBlurOptions);
          }
          // Controls whether the toolbar icon/shortcut opens the popup or
          // the side panel from now on — see applyUiMode above.
          if (nextSettings.uiMode !== wasUiMode) {
            await applyUiMode(nextSettings.uiMode);
          }
          sendResponse({ ok: true });
          break;
        }

        // ---- activation key / cloud sync ----
        case 'activate': {
          const result = await activate(msg.key);
          // Reactivating (e.g. after an uninstall/reinstall) wiped local
          // storage back to defaults — sync is already "on" there, but
          // there's nothing to poll for yet until this forces one pull, so
          // whatever this key already has saved on the server comes back
          // immediately instead of waiting for the next once-a-minute poll.
          if (result.ok) await pullAfterActivate();
          sendResponse(result);
          break;
        }
        case 'deactivate': {
          await deactivate();
          sendResponse({ ok: true });
          break;
        }
        // Heartbeat on demand — the popup fires this on open so a key that
        // died while the browser was closed is caught immediately.
        case 'licenseStatus': {
          sendResponse(await checkStatus());
          break;
        }
        case 'syncNow': {
          await syncNow();
          sendResponse({ ok: true });
          break;
        }
        case 'syncPollNow': {
          await pollPull(false);
          sendResponse({ ok: true });
          break;
        }
        case 'adminListKeys': {
          sendResponse(await licenseAdmin('/admin/list', {}));
          break;
        }
        case 'adminPutKey': {
          sendResponse(await licenseAdmin('/admin/put', { key: msg.key, record: msg.record }));
          break;
        }
        case 'adminRevokeKey': {
          sendResponse(await licenseAdmin('/admin/revoke', { key: msg.key }));
          break;
        }
        case 'adminDeleteKey': {
          sendResponse(await licenseAdmin('/admin/delete', { key: msg.key }));
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;
});
