// Activation-key licensing client — runs entirely inside background.js (the
// service worker). popup.js never calls the server itself; it sends
// 'activate' / 'deactivate' / 'licenseStatus' / 'admin*' messages the same
// way it does for every other action, and reads the result back off
// getState().license like any other piece of state.
//
// There are no user accounts: a customer pastes an activation key you issued
// (see server/README.md), the server binds it to this install's device id
// (seat limit per key), and everything they sync lives under that key.
//
// ┌─ SET THIS ───────────────────────────────────────────────────────────────┐
// │ Paste your deployed Cloudflare Worker URL below to TURN ON licensing.     │
// │ Leave it empty ("") for development — the extension then works locally    │
// │ with no activation required (and cloud sync stays off).                   │
// └──────────────────────────────────────────────────────────────────────────┘
export const LICENSE_SERVER = 'https://wa-scheduler-license.ranakiller-59.workers.dev';

const base = LICENSE_SERVER.replace(/\/+$/, '');
export const enforced = () => !!base;

// Everything the license state consists of, in chrome.storage.local. Kept as
// flat keys (not one object) so a single field can be updated without a
// read-modify-write, same as the rest of this extension's storage.
const LICENSE_KEYS = [
  'licenseKey',
  'licenseValid',
  'licenseName',
  'licenseSeats',
  'licenseUsed',
  'licenseExpiry',
  'licenseMaster',
  'licenseCheckedAt',
  'licenseDevice'
];

// A stable per-install id so a key can be bound to a limited number of
// devices. Cached in LOCAL storage (fast, always available), but the
// canonical copy also lives in SYNC storage — which is tied to the signed-in
// Chrome/Edge profile, not the install, and survives an uninstall/reinstall.
// So reinstalling in the same signed-in profile recovers the SAME device id
// instead of minting a new random one and quietly burning another seat. If
// sync storage isn't available (not signed in, sync disabled), this
// degrades to local-only.
export async function getDevice() {
  const local = await chrome.storage.local.get(['licenseDevice']);
  if (local.licenseDevice) return local.licenseDevice;
  let synced = {};
  try {
    synced = (await chrome.storage.sync.get(['licenseDevice'])) || {};
  } catch (_) {
    synced = {};
  }
  if (synced.licenseDevice) {
    await chrome.storage.local.set({ licenseDevice: synced.licenseDevice });
    return synced.licenseDevice;
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ licenseDevice: id });
  chrome.storage.sync.set({ licenseDevice: id }).catch(() => {}); // best-effort
  return id;
}

async function post(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad server response' }));
  return { status: res.status, data };
}

// Only these mean the KEY/DEVICE itself is dead (revoked, expired, deleted,
// or a device an admin reset). A network blip, a 5xx, or "device limit
// reached" must never lock out an otherwise-valid customer — the cached
// activation stays and gets re-checked on the next heartbeat.
export function isDeadKeyError(message) {
  return /invalid|revoked|expired/i.test(String(message || ''));
}

// Current activation state, in the shape popup.js reads off getState().
export async function getLicense() {
  const x = await chrome.storage.local.get(LICENSE_KEYS);
  return {
    enforced: enforced(),
    activated: enforced() ? !!x.licenseValid : true, // dev mode = always "activated"
    key: x.licenseKey || '',
    name: x.licenseName || '',
    seats: x.licenseSeats ?? null,
    used: x.licenseUsed ?? null,
    expires: x.licenseExpiry || '',
    master: !!x.licenseMaster,
    checkedAt: x.licenseCheckedAt || 0
  };
}

async function storeStatus(key, data) {
  await chrome.storage.local.set({
    licenseKey: key,
    licenseValid: true,
    licenseName: data.name || '',
    licenseSeats: data.seats ?? null,
    licenseUsed: data.used ?? null,
    licenseExpiry: data.expires || '',
    licenseMaster: !!data.master,
    licenseCheckedAt: Date.now()
  });
}

// Validate a key with the server and remember it. The one place a new
// device gets admitted to a key's seats.
export async function activate(key) {
  if (!enforced()) return { ok: true };
  key = (key || '').trim();
  if (!key) return { ok: false, error: 'Enter your activation key.' };
  const device = await getDevice();
  let r;
  try {
    r = await post('/activate', { key, device });
  } catch (_) {
    return { ok: false, error: 'Cannot reach the license server — check your internet connection.' };
  }
  if (r.data && r.data.ok) {
    await storeStatus(key, r.data);
    return { ok: true, ...(await getLicense()) };
  }
  await chrome.storage.local.set({ licenseValid: false });
  return { ok: false, error: (r.data && r.data.error) || 'Invalid or revoked key' };
}

export async function deactivate() {
  await chrome.storage.local.set({
    licenseKey: '',
    licenseValid: false,
    licenseName: '',
    licenseSeats: null,
    licenseUsed: null,
    licenseExpiry: '',
    licenseMaster: false
  });
}

// Periodic re-validation ("heartbeat"): if a key gets revoked, edited,
// deleted, or has its devices reset, this catches it — the strict server
// check never re-admits a device, so an admin's "Reset devices" sticks.
export async function checkStatus() {
  if (!enforced()) return { ok: true };
  const x = await chrome.storage.local.get(['licenseKey', 'licenseValid']);
  if (!x.licenseKey || !x.licenseValid) return { ok: false, error: 'Not activated' };
  const device = await getDevice();
  let r;
  try {
    r = await post('/status', { key: x.licenseKey, device });
  } catch (_) {
    return { ok: false, error: 'Cannot reach the license server' }; // keep cached activation
  }
  if (r.data && r.data.ok) {
    await storeStatus(x.licenseKey, r.data);
    return { ok: true };
  }
  const err = (r.data && r.data.error) || 'Bad server response';
  if (isDeadKeyError(err)) await chrome.storage.local.set({ licenseValid: false });
  return { ok: false, error: err };
}

// The two headers every licensed sync call carries, or null if this
// install isn't activated (sync.js treats that as "nothing to do").
export async function licensedHeaders() {
  if (!enforced()) return null;
  const x = await chrome.storage.local.get(['licenseKey', 'licenseValid']);
  if (!x.licenseKey || !x.licenseValid) return null;
  return { 'X-License': x.licenseKey, 'X-Device': await getDevice() };
}

// Master-key-gated key management (the Keys tab). The active key is sent
// as the admin credential; the server only allows these when it has
// master:true.
export async function admin(path, body) {
  if (!enforced()) return { ok: false, error: 'Licensing not configured (LICENSE_SERVER is empty)' };
  const x = await chrome.storage.local.get(['licenseKey']);
  if (!x.licenseKey) return { ok: false, error: 'Not activated' };
  let r;
  try {
    r = await post(path, body, { 'X-Admin': x.licenseKey });
  } catch (_) {
    return { ok: false, error: 'Cannot reach the license server' };
  }
  return r.data && typeof r.data === 'object' ? r.data : { ok: false, error: 'Bad server response' };
}
