# WhatsApp Scheduler license + sync server

A tiny Cloudflare Worker (free tier is plenty) that does two things for the
extension:

1. **Activation keys** — no user accounts, no Google sign-in. You issue a key,
   the customer pastes it in, the extension works. Revoke the key in KV and
   that customer stops working within minutes (the extension re-checks its key
   periodically).
2. **Cloud sync** — messages (attachments included), lists, settings and the
   log for each key are stored under that key, so a second device activated
   with the same key gets the same data.

This folder is **not** part of the extension itself — nothing in here ships to
customers.

## One-time setup

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
cd server
npm i -g wrangler            # or: npx wrangler ...
wrangler login

# 1) Create the KV namespace that stores your keys + synced data
wrangler kv namespace create LICENSES
#   → copy the printed id into wrangler.toml ([[kv_namespaces]] id = "...")

# 2) Deploy
wrangler deploy
#   → it prints your URL, e.g. https://wa-scheduler-license.<you>.workers.dev
```

Paste that URL into `LICENSE_SERVER` at the top of `../license.js` and reload
the extension. While `LICENSE_SERVER` is left empty the extension runs in
**dev mode** — no activation needed, sync disabled.

## Create your master key (do this first)

The master key unlocks the **Keys** tab inside the extension, where you create,
edit, reset, revoke and delete customer keys without ever touching the CLI
again. Make one by hand:

```bash
wrangler kv key put --binding=LICENSES "WAS-MASTER-<something-random>" "{\"name\":\"Me\",\"master\":true}" --remote
```

Activate the extension with that key → the Keys tab appears.

> ⚠️ Always pass `--remote` — without it you only write to a local test copy.

## Device binding (anti-sharing)

Each install gets a random device id. A key works on a limited number of
devices (**seats**, default 2); the server registers each new device on
activation and rejects any beyond the limit ("Device limit reached"). A
shared key can never exceed its cap, so sharing is self-defeating. "Reset
devices" on a key (Keys tab) frees every seat — e.g. a customer got a new PC.

## Key record format (what's stored in KV)

```json
{"name":"Ali Travels","seats":2,"devices":[],"expires":"2027-01-31"}
```

- `expires` — `YYYY-MM-DD` (valid through the end of that day) or omitted for
  never.
- `master: true` — unlimited devices, never expires, unlocks the Keys tab.
- The plain string `revoked` disables a key.

The Keys tab writes these for you; the CLI equivalents are just
`wrangler kv key put/get/list/delete --binding=LICENSES ... --remote`, or the
Cloudflare dashboard (Workers & Pages → KV → your LICENSES namespace).

## How sync data is stored

Everything lives in the same KV namespace, namespaced by key:

| KV entry              | Holds                                                  |
| --------------------- | ------------------------------------------------------ |
| `sync:<key>`          | one snapshot `{ data, at, device }` — newest push wins |
| `media:<key>:<hash>`  | one attachment (data URL), content-addressed           |
| `mediaidx:<key>`      | list of which attachment hashes exist for this key     |

Attachments are uploaded once per file (a `/sync/media/check` call tells the
extension what's missing) and are never deleted automatically — with KV's
free 1 GB that's a lot of images before it matters. If a customer's key is
deleted, their `sync:`/`media:` entries stay behind; clean them up from the
dashboard if you care.

Free-tier limits worth knowing: 1,000 KV **writes/day**, 100,000 reads/day.
The extension debounces and rate-limits its pushes (at most one snapshot push
per 30 seconds per device) specifically so a long campaign writing to the log
every send doesn't burn through that.
