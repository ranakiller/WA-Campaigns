// Cloud sync against the license server (server/worker.js) — runs entirely
// inside background.js (the service worker) so it keeps working while the
// popup is closed (a scheduled send appending to the log at 3am still gets
// pushed). This file only ever transports whatever's already in
// chrome.storage.local; it doesn't change what any of the existing send/UI
// code expects to find there.
//
// Model: ONE snapshot per activation key ({messages, lists, settings, log}),
// whole-value last-write-wins by a plain timestamp. A local change auto-
// pushes (debounced, and never more often than once per 30s — a campaign
// writes to the log every send, and Cloudflare KV's free tier is 1,000
// writes/day); changes from other devices are picked up by polling once a
// minute via chrome.alarms (the only thing that reliably survives this
// service worker being suspended) plus immediately whenever the popup
// opens. Turning sync on does one forced pull first, so a new device
// joining an existing key doesn't start by overwriting the cloud copy with
// its own empty/different local state.
//
// Attachments (images/PDFs/docs) are the one thing that isn't inline in the
// snapshot: a message's items keep their normal { dataUrl, filename,
// mimeType } shape locally, but the synced copy has { hash, filename,
// mimeType } instead, with the bytes stored separately, content-addressed
// by a SHA-256 of the data URL — so the same attachment reused across
// messages/devices only ever uploads once.
import { LICENSE_SERVER, licensedHeaders, isDeadKeyError } from './license.js';

export const SYNC_KEYS = ['messages', 'lists', 'settings', 'log'];
export const SYNC_ALARM = 'cloudSyncPoll';

// Per-device settings that must never be overwritten by another device's
// snapshot: the sync toggle itself, the master on/off switch (a kill
// switch flipped on one machine shouldn't silently disarm another), and
// the theme.
const SETTINGS_LOCAL_ONLY = ['syncEnabled', 'masterEnabled', 'theme'];

const PUSH_DEBOUNCE_MS = 2000;
const PUSH_MIN_INTERVAL_MS = 30000;

const base = LICENSE_SERVER.replace(/\/+$/, '');

// ---------- resuming sync after an uninstall/reinstall ----------
// syncEnabled defaults to false (see background.js's DEFAULT_SETTINGS) —
// sync is opt-in, so a fresh activation alone never starts pulling/pushing
// anything; the user has to explicitly flip the toggle in Settings, which is
// what actually calls pollPull(true) (see background.js's saveSettings
// case). This function only matters for the case where sync WAS already on
// before an uninstall wiped chrome.storage.local back to defaults (which
// resets syncEnabled to off too) — once the user re-activates AND turns
// sync back on themselves, this forces one immediate pull instead of
// waiting for the next once-a-minute poll.
export async function pullAfterActivate() {
  if (!(await syncEnabled())) return;
  await setSyncAlarm(true);
  await pollPull(true);
}

// Set by background.js — called after a pulled snapshot has been written to
// storage (it needs to rebuild chrome.alarms for any schedules that came
// with the messages). Kept as a callback rather than an import to avoid a
// circular dependency.
let onRemoteApplied = null;
export function setOnRemoteApplied(fn) {
  onRemoteApplied = fn;
}

// ---------- status (what the popup's sync row shows) ----------
async function getSyncStatus() {
  const data = await chrome.storage.local.get(['cloudSync']);
  return data.cloudSync || {};
}
async function setSyncStatus(patch) {
  const current = await getSyncStatus();
  await chrome.storage.local.set({ cloudSync: { ...current, ...patch } });
}

async function syncEnabled() {
  const data = await chrome.storage.local.get(['settings']);
  return !!(data.settings && data.settings.syncEnabled);
}

// ---------- media transport ----------
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Local -> cloud: strip every attachment's bytes out of the messages,
// returning the media (hash -> dataUrl) separately so the caller can upload
// whichever of them the server doesn't have yet.
async function toCloudShape(messages) {
  const media = new Map();
  const out = [];
  for (const m of messages || []) {
    const items = [];
    for (const item of m.items || []) {
      if (item.kind === 'media' && item.media && item.media.dataUrl) {
        const hash = item.media.hash || (await sha256Hex(item.media.dataUrl));
        media.set(hash, item.media.dataUrl);
        items.push({ ...item, media: { filename: item.media.filename, mimeType: item.media.mimeType, hash } });
      } else {
        items.push(item);
      }
    }
    out.push({ ...m, items });
  }
  return { messages: out, media };
}

// Cloud -> local: put the bytes back. Anything this device already holds
// (matched by hash, so an attachment it uploaded itself is never
// re-downloaded) comes from local storage; the rest is fetched. Throws on
// any download failure so a pull is all-or-nothing — a message whose
// attachment is missing can't be sent, so it's better to keep the previous
// local copy and retry on the next poll than apply a half-broken snapshot.
async function fromCloudShape(cloudMessages, localMessages, headers) {
  const localByHash = new Map();
  for (const m of localMessages || []) {
    for (const item of m.items || []) {
      if (item.kind === 'media' && item.media && item.media.dataUrl) {
        const hash = item.media.hash || (await sha256Hex(item.media.dataUrl));
        localByHash.set(hash, item.media.dataUrl);
      }
    }
  }
  const out = [];
  for (const m of cloudMessages || []) {
    const items = [];
    for (const item of m.items || []) {
      if (item.kind === 'media' && item.media && item.media.hash && !item.media.dataUrl) {
        const { hash } = item.media;
        let dataUrl = localByHash.get(hash);
        if (!dataUrl) {
          const res = await fetch(`${base}/sync/media/${hash}`, { headers });
          if (!res.ok) throw new Error(`Couldn't download attachment "${item.media.filename}" (${res.status})`);
          dataUrl = await res.text();
          localByHash.set(hash, dataUrl);
        }
        // hash kept alongside dataUrl so the next push/pull can skip re-hashing it
        items.push({ ...item, media: { filename: item.media.filename, mimeType: item.media.mimeType, dataUrl, hash } });
      } else {
        items.push(item);
      }
    }
    out.push({ ...m, items });
  }
  return out;
}

// Hashes confirmed present on the server during this service worker's
// lifetime — skips even the /check round-trip for them.
const uploadedMediaHashes = new Set();

async function uploadMissingMedia(media, headers) {
  const unknown = Array.from(media.keys()).filter((h) => !uploadedMediaHashes.has(h));
  if (unknown.length === 0) return;
  const check = await postJson('/sync/media/check', { hashes: unknown }, headers);
  if (!check.data || !check.data.ok) throw new Error((check.data && check.data.error) || 'Attachment check failed');
  const missing = new Set(check.data.missing || []);
  for (const hash of unknown) {
    if (missing.has(hash)) {
      const res = await fetch(`${base}/sync/media/${hash}`, { method: 'PUT', headers, body: media.get(hash) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Attachment upload failed (${res.status})`);
    }
    uploadedMediaHashes.add(hash);
  }
}

async function postJson(path, body, headers) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad server response' }));
  return { status: res.status, data };
}

// ---------- popup notifications ----------
// One-way heads-up to the popup, if it happens to be open — it also always
// gets the fuller picture from the persistent status row (Settings tab,
// STATE.cloudSync), this is just the "something happened" ping. Silently
// dropped when the popup is closed (sendMessage with no listener just
// rejects), which is fine — the status row catches it up next time it's opened.
function notifyPopup(message, type = 'info') {
  try {
    chrome.runtime.sendMessage({ action: 'toast', message, type }).catch(() => {});
  } catch (_) {
    // service worker context without a runtime, or similar — never fatal
  }
}

// Avoids re-toasting the exact same error every single one-minute poll
// retry — only surfaces it when it's new, or once it clears.
let lastNotifiedError = '';

// A dead key (revoked/expired/reset device) discovered mid-sync flips the
// cached activation off right away — same rule as license.js's heartbeat —
// so the popup drops back to the activation screen instead of retrying
// forever.
async function handleSyncError(err) {
  const message = String((err && err.message) || err || 'Sync failed');
  if (isDeadKeyError(message)) await chrome.storage.local.set({ licenseValid: false });
  await setSyncStatus({ lastError: message, inProgress: false });
  if (message !== lastNotifiedError) {
    lastNotifiedError = message;
    notifyPopup(`Sync error: ${message}`, 'error');
  }
}

// ---------- push (local change -> cloud) ----------
let pushTimer = null;
let pushing = false;
let pushRequestedWhileBusy = false;

export function scheduleAutoPush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushNow().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
}

export async function pushNow() {
  if (!(await syncEnabled())) return;
  const headers = await licensedHeaders();
  if (!headers) return;
  if (pushing) {
    pushRequestedWhileBusy = true; // coalesce — one more push after this one lands
    return;
  }
  const status = await getSyncStatus();
  const sinceLast = Date.now() - (status.lastPushAt || 0);
  if (sinceLast < PUSH_MIN_INTERVAL_MS) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushNow().catch(() => {});
    }, PUSH_MIN_INTERVAL_MS - sinceLast);
    return;
  }
  pushing = true;
  try {
    await setSyncStatus({ inProgress: true });
    const local = await chrome.storage.local.get(SYNC_KEYS);
    const { messages, media } = await toCloudShape(local.messages || []);
    const settings = { ...(local.settings || {}) };
    for (const k of SETTINGS_LOCAL_ONLY) delete settings[k];
    await uploadMissingMedia(media, headers);
    const r = await postJson('/sync/push', { data: { messages, lists: local.lists || [], settings, log: local.log || [] } }, headers);
    if (!r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'Push failed');
    await setSyncStatus({ lastAt: r.data.at, lastPushAt: Date.now(), lastError: '', inProgress: false });
    lastNotifiedError = '';
    notifyPopup('Synced to cloud', 'success');
  } catch (err) {
    await handleSyncError(err);
  } finally {
    pushing = false;
    if (pushRequestedWhileBusy) {
      pushRequestedWhileBusy = false;
      scheduleAutoPush();
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- pull (cloud -> local) ----------
// Applies the server snapshot ONLY if it's newer than what this device
// already reflects (cloudSync.lastAt, which both push and pull keep up to
// date) — so polling every minute doesn't reapply data that hasn't changed.
// `force` skips that check — used when sync is first turned on.
let pulling = false;
export async function pollPull(force = false) {
  if (!(await syncEnabled())) return;
  const headers = await licensedHeaders();
  if (!headers) {
    if (force) await setSyncStatus({ lastError: 'Not activated' });
    return;
  }
  if (pulling) return;
  pulling = true;
  try {
    await setSyncStatus({ inProgress: true });
    let r = await postJson('/sync/pull', {}, headers);
    // Cloudflare KV reads can lag a write by a few seconds across edge
    // locations — a forced pull (a brand-new device joining an existing
    // key) is the one time a false "no data yet" here is actually
    // dangerous, since the caller's next move is to push and seed the
    // cloud copy. A couple of short retries makes that a lot less likely
    // to race a very recent write from another device.
    if (force && (!r.data || !r.data.ok) && /no synced data/i.test((r.data && r.data.error) || '')) {
      for (const delayMs of [1500, 3000]) {
        await sleep(delayMs);
        r = await postJson('/sync/pull', {}, headers);
        if (r.data && r.data.ok) break;
      }
    }
    const d = r.data;
    if (!d || !d.ok || !d.data || typeof d.data !== 'object') {
      const err = (d && d.error) || 'Pull failed';
      // "No synced data found for this key yet" just means this is the first
      // device to ever turn sync on for this key — not an error to surface;
      // its next push seeds the cloud copy.
      if (/no synced data/i.test(err)) {
        await setSyncStatus({ inProgress: false, lastError: '' });
        return;
      }
      throw new Error(err);
    }
    const status = await getSyncStatus();
    const serverAt = d.at || 0;
    if (!force && serverAt <= (status.lastAt || 0)) {
      await setSyncStatus({ inProgress: false });
      return;
    }
    const local = await chrome.storage.local.get(['messages', 'lists', 'log', 'settings']);
    const remote = d.data;
    const remoteMessages = Array.isArray(remote.messages) ? remote.messages : null;
    const remoteLists = Array.isArray(remote.lists) ? remote.lists : null;
    const remoteLog = Array.isArray(remote.log) ? remote.log : null;
    // Guard against a blank snapshot wiping out real local data. This is
    // what actually happened in the wild: a second device joined a key,
    // its own forced pull came back empty (KV lag, a dropped request,
    // whatever), it went ahead and pushed its still-blank local state, and
    // every other device polling that key faithfully overwrote its real
    // data with nothing. If the incoming snapshot has nothing in it but
    // this device visibly does, don't apply it — push this device's data
    // back up instead, so the bad write gets corrected (and every other
    // device picks up the real data on its next poll) instead of the
    // emptiness spreading further.
    const remoteLooksBlank =
      (remoteMessages == null || remoteMessages.length === 0) &&
      (remoteLists == null || remoteLists.length === 0) &&
      (remoteLog == null || remoteLog.length === 0);
    const localHasData =
      (local.messages || []).length > 0 || (local.lists || []).length > 0 || (local.log || []).length > 0;
    if (remoteLooksBlank && localHasData) {
      await setSyncStatus({ lastAt: serverAt, inProgress: false, lastError: '' });
      notifyPopup("Cloud copy looked empty — kept this device's data and re-synced it up.", 'info');
      scheduleAutoPush();
      return;
    }
    const next = {};
    if (remoteMessages) next.messages = await fromCloudShape(remoteMessages, local.messages || [], headers);
    if (remoteLists) next.lists = remoteLists;
    if (remoteLog) next.log = remoteLog;
    if (remote.settings && typeof remote.settings === 'object') {
      const localSettings = local.settings || {};
      const merged = { ...localSettings, ...remote.settings };
      for (const k of SETTINGS_LOCAL_ONLY) if (k in localSettings) merged[k] = localSettings[k];
      next.settings = merged;
    }
    // Written straight to storage — deliberately NOT through background.js's
    // setState(), whose sync hook would immediately push this exact
    // snapshot right back up.
    await chrome.storage.local.set(next);
    await setSyncStatus({ lastAt: serverAt, lastPulledAt: Date.now(), lastError: '', inProgress: false });
    lastNotifiedError = '';
    if (Object.keys(next).length > 0) notifyPopup('Synced from cloud', 'success');
    if (next.messages && onRemoteApplied) await onRemoteApplied();
  } catch (err) {
    await handleSyncError(err);
  } finally {
    pulling = false;
  }
}

// "Sync now" — push whatever's pending (ignoring the 30s rate limit, this
// was an explicit click), then pull.
export async function syncNow() {
  clearTimeout(pushTimer);
  await setSyncStatus({ lastPushAt: 0 });
  await pushNow();
  await pollPull(false);
}

export async function setSyncAlarm(on) {
  if (on) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(SYNC_ALARM);
}
