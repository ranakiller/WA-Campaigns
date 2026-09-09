/*
 * WhatsApp Scheduler license + cloud-sync server (Cloudflare Worker).
 *
 * Replaces the earlier Google-sign-in + Firebase setup: there are no user
 * accounts at all. You issue ACTIVATION KEYS (stored in a KV namespace you
 * control); a customer pastes one into the extension, and everything they
 * sync (messages incl. attachments, lists, settings, log) lives under that
 * key. Revoke the key and that customer is cut off within seconds.
 *
 * Endpoints (all JSON unless noted):
 *   POST /activate     { key, device }                 → { ok, name, seats, used, expires, master }
 *   POST /status       { key, device }                 → same shape (heartbeat; never admits a new device)
 *   POST /admin/list   X-Admin: <master key>           → { ok, keys: [...] }
 *   POST /admin/put    X-Admin  { key, record }        → { ok }
 *   POST /admin/revoke X-Admin  { key }                → { ok }
 *   POST /admin/delete X-Admin  { key }                → { ok }
 *
 *   Cloud sync (X-License + X-Device headers on every call):
 *   POST /sync/push         { data }                   → { ok, at }        one snapshot slot per key
 *   POST /sync/pull         {}                         → { ok, data, at, device }
 *   POST /sync/media/check  { hashes: [...] }          → { ok, missing: [...] }
 *   PUT  /sync/media/<hash> body = data URL (text)     → { ok }            content-addressed attachment
 *   GET  /sync/media/<hash>                            → data URL (text)
 *
 * Bindings (see wrangler.toml / README):
 *   LICENSES   KV namespace
 *     <key>                 → license record (see getRecord)
 *     sync:<key>            → { data, at, device }   the snapshot
 *     media:<key>:<hash>    → data URL string        one attachment
 *     mediaidx:<key>        → ["<hash>", ...]        which attachments exist for this key
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-License, X-Device, X-Admin'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// Default number of devices a single key may run on. Override per key by
// storing a JSON record: {"name":"Ali","seats":3,"devices":[]}
const DEFAULT_SEATS = 2;

const SYNC_PREFIX = 'sync:';
const MEDIA_PREFIX = 'media:';
const MEDIA_INDEX_PREFIX = 'mediaidx:';
// KV caps a single value at 25 MiB. The snapshot never holds attachment
// bytes (those are separate media: entries), so 20 MB of text is enormous
// headroom; a single attachment gets the same cap (a 15 MB file is ~20 MB
// as a data URL, and the extension already warns above 15 MB).
const SYNC_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_MAX_BYTES = 24 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;

// Load a key's record. A KV value can be either:
//   • a JSON object  {name, seats, devices, expires?, master?}   (full record)
//   • a plain string "Ali Travels"                                 (legacy → default seats)
//   • the word       "revoked"                                     (disabled)
// expires: ISO date "YYYY-MM-DD" or epoch ms, or null = never expires.
// master: true = unlimited devices, never expires, unlocks the Keys admin tab.
async function getRecord(env, key) {
  if (!key || !env.LICENSES) return null;
  const raw = await env.LICENSES.get(key.trim());
  if (raw == null) return null;
  if (String(raw).trim().toLowerCase() === 'revoked') return null;

  let rec = null;
  try {
    rec = JSON.parse(raw);
  } catch (_) {
    /* legacy plain string */
  }
  if (!rec || typeof rec !== 'object') rec = { name: String(raw) };

  if (typeof rec.seats !== 'number' || rec.seats < 1) rec.seats = DEFAULT_SEATS;
  if (!Array.isArray(rec.devices)) rec.devices = [];
  if (!rec.name) rec.name = 'active';
  rec.master = !!rec.master;
  if (rec.expires === undefined) rec.expires = null;
  return rec;
}

// A key is expired when "expires" is set and we're past the END of that day.
function isExpired(rec) {
  if (rec.master || !rec.expires) return false;
  const t = typeof rec.expires === 'number' ? rec.expires : Date.parse(rec.expires);
  return Number.isFinite(t) && Date.now() > t + 86400000; // +1 day = valid through that date
}

// Admin = the request carries a valid MASTER key in X-Admin.
async function isAdmin(env, request) {
  const rec = await getRecord(env, request.headers.get('X-Admin') || '');
  return !!(rec && rec.master);
}

// Decide whether this device may use the key, registering it if there's room.
// Only /activate calls this — it's the one place a device is meant to be
// newly admitted (the user explicitly entered their key).
function admitDevice(rec, device) {
  if (rec.master) return { ok: true, changed: false }; // master = unlimited, no tracking
  device = (device || '').trim();
  if (!device) return { ok: false, error: 'Missing device id' };
  if (rec.devices.includes(device)) return { ok: true, changed: false };
  if (rec.devices.length < rec.seats) {
    rec.devices.push(device);
    return { ok: true, changed: true };
  }
  return { ok: false, error: `Device limit reached (${rec.seats}). Contact support to reset.` };
}

// Stricter check for everything that ISN'T /activate: the device must
// ALREADY be registered — this never adds one. Otherwise an admin's "Reset
// devices" would be undone by the very next heartbeat/sync silently
// re-claiming a freed seat; rejecting here instead makes the extension
// prompt the user to re-enter their key through /activate.
function requireActiveDevice(rec, device) {
  if (rec.master) return { ok: true };
  device = (device || '').trim();
  if (!device) return { ok: false, error: 'Missing device id' };
  if (!rec.devices.includes(device)) {
    return { ok: false, error: 'Invalid device — please re-activate this key' };
  }
  return { ok: true };
}

function statusPayload(rec) {
  return {
    ok: true,
    name: rec.name,
    seats: rec.seats,
    used: rec.devices.length,
    expires: rec.expires || null,
    master: rec.master
  };
}

// Shared guard for every licensed (non-activate) call: valid key, not
// expired, device already registered. Returns the record, or a Response.
async function requireLicensed(env, request) {
  const key = request.headers.get('X-License') || '';
  const device = request.headers.get('X-Device') || '';
  const rec = await getRecord(env, key);
  if (!rec) return { error: json({ ok: false, error: 'Invalid or revoked key' }, 403) };
  if (isExpired(rec)) return { error: json({ ok: false, error: 'Key expired' }, 403) };
  const adm = requireActiveDevice(rec, device);
  if (!adm.ok) return { error: json({ ok: false, error: adm.error }, 403) };
  return { rec, key: key.trim(), device };
}

async function getMediaIndex(env, key) {
  const raw = await env.LICENSES.get(MEDIA_INDEX_PREFIX + key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('WhatsApp Scheduler license server — OK', { headers: CORS });
    }

    try {
      if (url.pathname === '/activate' && request.method === 'POST') {
        const { key, device } = await request.json();
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: 'Invalid or revoked key' }, 403);
        if (isExpired(rec)) return json({ ok: false, error: 'Key expired' }, 403);
        const adm = admitDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        if (adm.changed) await env.LICENSES.put(key.trim(), JSON.stringify(rec));
        return json(statusPayload(rec));
      }

      // Periodic re-validation ("heartbeat") — a key that gets revoked,
      // edited, deleted, or has its devices reset while a customer is
      // mid-session gets caught within minutes. STRICT device check.
      if (url.pathname === '/status' && request.method === 'POST') {
        const { key, device } = await request.json();
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: 'Invalid or revoked key' }, 403);
        if (isExpired(rec)) return json({ ok: false, error: 'Key expired' }, 403);
        const adm = requireActiveDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        return json(statusPayload(rec));
      }

      // ── Admin (master key only): manage the whole key list ──────────────
      if (url.pathname.startsWith('/admin/') && request.method === 'POST') {
        if (!(await isAdmin(env, request))) return json({ ok: false, error: 'Not authorized' }, 403);

        if (url.pathname === '/admin/list') {
          const list = await env.LICENSES.list();
          const keys = [];
          for (const k of list.keys) {
            if (k.name.includes(':')) continue; // sync:/media:/mediaidx: entries, not license keys
            const raw = await env.LICENSES.get(k.name);
            const revoked = String(raw || '').trim().toLowerCase() === 'revoked';
            let rec = null;
            try {
              rec = JSON.parse(raw);
            } catch (_) {}
            if (rec && typeof rec === 'object') {
              keys.push({
                key: k.name,
                name: rec.name || '',
                seats: rec.seats ?? null,
                devices: Array.isArray(rec.devices) ? rec.devices : [],
                expires: rec.expires || null,
                master: !!rec.master,
                revoked: false
              });
            } else {
              keys.push({
                key: k.name,
                name: revoked ? '(revoked)' : String(raw || ''),
                seats: null,
                devices: [],
                expires: null,
                master: false,
                revoked
              });
            }
          }
          keys.sort((a, b) => a.key.localeCompare(b.key));
          return json({ ok: true, keys });
        }

        if (url.pathname === '/admin/put') {
          const { key, record } = await request.json();
          if (!key || !key.trim()) return json({ ok: false, error: 'No key' }, 400);
          if (key.includes(':')) return json({ ok: false, error: 'Key cannot contain ":"' }, 400);
          if (!record || typeof record !== 'object') return json({ ok: false, error: 'Bad record' }, 400);
          await env.LICENSES.put(key.trim(), JSON.stringify(record));
          return json({ ok: true });
        }

        if (url.pathname === '/admin/revoke') {
          const { key } = await request.json();
          if (!key || !key.trim()) return json({ ok: false, error: 'No key' }, 400);
          await env.LICENSES.put(key.trim(), 'revoked');
          return json({ ok: true });
        }

        if (url.pathname === '/admin/delete') {
          const { key } = await request.json();
          if (!key || !key.trim()) return json({ ok: false, error: 'No key' }, 400);
          await env.LICENSES.delete(key.trim());
          return json({ ok: true });
        }

        return json({ ok: false, error: 'Unknown admin action' }, 404);
      }

      // ── Cloud sync ───────────────────────────────────────────────────────
      if (url.pathname.startsWith('/sync/')) {
        const lic = await requireLicensed(env, request);
        if (lic.error) return lic.error;
        const { key, device } = lic;

        if (url.pathname === '/sync/push' && request.method === 'POST') {
          const body = await request.json().catch(() => null);
          const data = body && body.data;
          if (!data || typeof data !== 'object') return json({ ok: false, error: 'No data to sync' }, 400);
          const at = Date.now();
          const payload = JSON.stringify({ data, at, device });
          if (payload.length > SYNC_MAX_BYTES) return json({ ok: false, error: 'Too much data to sync' }, 400);
          await env.LICENSES.put(SYNC_PREFIX + key, payload);
          return json({ ok: true, at });
        }

        if (url.pathname === '/sync/pull' && request.method === 'POST') {
          const raw = await env.LICENSES.get(SYNC_PREFIX + key);
          if (raw == null) return json({ ok: false, error: 'No synced data found for this key yet' }, 404);
          let saved;
          try {
            saved = JSON.parse(raw);
          } catch (_) {
            return json({ ok: false, error: 'Corrupt sync data' }, 500);
          }
          return json({ ok: true, data: saved.data, at: saved.at, device: saved.device });
        }

        // Which of these attachment hashes does the server NOT have yet —
        // so a device only ever uploads what's actually missing (one small
        // index read instead of probing each entry).
        if (url.pathname === '/sync/media/check' && request.method === 'POST') {
          const body = await request.json().catch(() => null);
          const hashes = (body && Array.isArray(body.hashes) ? body.hashes : []).filter((h) => HASH_RE.test(h));
          const have = new Set(await getMediaIndex(env, key));
          return json({ ok: true, missing: hashes.filter((h) => !have.has(h)) });
        }

        const mediaMatch = /^\/sync\/media\/([a-f0-9]{64})$/.exec(url.pathname);
        if (mediaMatch && request.method === 'PUT') {
          const hash = mediaMatch[1];
          const dataUrl = await request.text();
          if (!dataUrl.startsWith('data:')) return json({ ok: false, error: 'Expected a data URL body' }, 400);
          if (dataUrl.length > MEDIA_MAX_BYTES) return json({ ok: false, error: 'Attachment too large to sync (24 MB max)' }, 400);
          await env.LICENSES.put(`${MEDIA_PREFIX}${key}:${hash}`, dataUrl);
          const index = await getMediaIndex(env, key);
          if (!index.includes(hash)) {
            index.push(hash);
            await env.LICENSES.put(MEDIA_INDEX_PREFIX + key, JSON.stringify(index));
          }
          return json({ ok: true });
        }
        if (mediaMatch && request.method === 'GET') {
          const dataUrl = await env.LICENSES.get(`${MEDIA_PREFIX}${key}:${mediaMatch[1]}`);
          if (dataUrl == null) return json({ ok: false, error: 'Attachment not found' }, 404);
          return new Response(dataUrl, { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
        }
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }
};
