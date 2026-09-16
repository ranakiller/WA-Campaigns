# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal-use Manifest V3 Chrome/Edge extension ("WhatsApp Message Scheduler") for a user's **own**
WhatsApp groups/contacts: fetch chats from WhatsApp Web's own internal data (not DOM scraping), organize
them into lists, build a library of text/media messages, and schedule sends directly on each message (no
separate "campaign" entity). Includes a lightweight CRM (contacts with status/tags/follow-ups), an
auto-reply engine, activation-key licensing, and optional cloud sync — all backed by a small Cloudflare
Worker the user deploys themselves. See `README.md` for full user-facing feature docs (very detailed —
read it before touching Messages/Lists/Scheduling/Sync behavior) and `server/README.md` for the license
server.

**Not intended for the Chrome Web Store** — automating WhatsApp Web this way violates WhatsApp's ToS; this
is sideloaded/"Load unpacked" only.

## Commands

There is no build step, bundler, package.json, linter, or test suite at the extension root — it's plain
vanilla JS loaded directly by the browser.

- **Run/reload the extension**: `chrome://extensions` (or `edge://extensions`) → Developer mode → Load
  unpacked → select the repo root. After any code change, click the reload icon on the extension card
  (and reload any open `web.whatsapp.com` tab if content-script/page-bridge/vendor files changed).
- **Update the vendored WhatsApp API library** if WhatsApp breaks it: re-download
  `https://unpkg.com/@wppconnect/wa-js/dist/wppconnect-wa.js` (+ its `.LICENSE.txt`) into `vendor/`.
- **Server (`server/`)** — a Cloudflare Worker, deployed independently, not shipped with the extension:
  ```bash
  cd server
  npm i -g wrangler
  wrangler login
  wrangler kv namespace create LICENSES   # one-time; paste id into wrangler.toml
  wrangler deploy
  ```
  No local dev server / test command is defined; `wrangler.toml` has no `[dev]` config beyond the
  namespace binding. There's also no package.json in `server/` — wrangler is invoked directly.

## Architecture

### Three JS worlds talking to each other

WhatsApp Web automation goes through WhatsApp's own internal Store API (via the vendored
`@wppconnect/wa-js`), never DOM scraping/simulated clicks. This requires bridging three separate JS
contexts:

1. **`vendor/wppconnect-wa.js` + `page-bridge.js`** — injected into the *page's own MAIN world*
   (`"world": "MAIN"` in `manifest.json`), where `window.WPP` is real. `page-bridge.js` is the only file
   that ever calls `window.WPP.*` directly (chat listing, sending, deleting, group metadata, etc.) and
   exposes a single `handleRequest(action, payload)` dispatcher.
2. **`content.js`** — the *isolated content-script world* (default extension world). Can't see
   `window.WPP` directly, so it relays: `chrome.runtime.onMessage` (from `background.js`) →
   `CustomEvent('wa-ext-request')` on `document` → `page-bridge.js` handles it → responds via
   `CustomEvent('wa-ext-response')`. Also owns the **privacy-blur** feature entirely (pure DOM/CSS against
   WhatsApp's own page structure — see `PRIVACY_BLUR_RULES`), since there's no WPP API for that.
3. **`background.js`** — the MV3 service worker. Owns all storage, scheduling (`chrome.alarms`), and talks
   to `content.js` via `chrome.tabs.sendMessage`/`chrome.runtime.onMessage`. This is where almost all
   business logic lives.

Two one-way event channels also exist for incoming messages: `wa-ext-notify` (auto-reply, filtered to
non-self text messages) and `wa-ext-relay` (unfiltered, for the external Nuskomate API — see below).

### Data model (all in `chrome.storage.local`)

No campaigns entity — **a schedule lives on the message it targets** (`message.schedules[]`). Key
top-level keys: `fetchedChats`, `lists`, `messages`, `log`, `settings`, `activeRuns`, `contacts`,
`cloudSync`, plus license keys (see `license.js`). `background.js`'s `getState()`/`setState()` are the
single read/write chokepoint; `migrateMessage()`/`migrateLegacyCampaignsIntoMessages()` handle one-time
shape migrations on read/startup so there's no separate migration step to run.

- **Message** = `{ items: [...], schedules: [...] }`. An item is `{kind:'text', text}` or
  `{kind:'media', media, caption}`. Items in one message send back-to-back to a chat with no delay;
  delay only applies *between chats/lists*.
- **List** = static (explicit `members`) or **smart** (`type:'smart'`, a filter over `contacts` —
  recomputed in `resolveSmartLists()`, called from `getState()` and again right before a scheduled send
  resolves targets, since an alarm can fire with the popup closed).
- **Schedule** types: `'times'` (daily HH:MM, one alarm per time), `'interval'` (native
  `chrome.alarms.periodInMinutes`, optionally windowed to active hours), `'once'` (one or more one-off
  datetimes, tombstoned to `null` after firing). Alarm names encode
  `${kind}:${messageId}:${scheduleId}[:${idx}]` for traceability.
- **`runCampaign(campaign)`** in `background.js` is the single send engine — every send path (scheduled,
  "Send now", "send to current chat", quick-send, auto-reply) builds a transient campaign-shaped object
  and calls this. It resolves targets, applies header/footer (`resolveHeaderFooter`: item → message →
  global settings, each layer able to opt out), paces sends via `settings.defaultDelayBetween*Ms`,
  inserts `THREAD_SEPARATOR` between multi-item threads when requested, updates `activeRuns` for live
  progress, and appends to `log`.
- **`activeRuns`** (in storage) is the live progress/pause/reset mechanism, polled by `waitToProceedOrStop`
  before every single item — so the master kill switch or a pause takes effect within one send, not after
  the whole run.

### Contacts / CRM

`contacts` is a simple array with `status` (`CONTACT_STATUSES` in `background.js`), `tags`, `notes`,
`nextFollowUpAt`/`followUpCadenceDays`. `runCampaign` stamps `lastContactedAt`/`nextFollowUpAt` on any
touched contact after a send completes — the only place that logic lives, since every send path funnels
through it.

### Cloud sync (`sync.js`) and licensing (`license.js`)

Opt-in (`settings.syncEnabled`, off by default). One whole-snapshot-per-key model,
**last-write-wins by timestamp** — not field merging. `SYNC_KEYS = ['messages','lists','settings','log',
'contacts']`; `SETTINGS_LOCAL_ONLY` fields (sync toggle, master switch, theme) never travel. Push is
debounced (2s) and rate-limited (≥30s apart); pull polls every minute via `chrome.alarms` (the only
MV3-safe way to keep working while the service worker is suspended) plus on popup open. Media
(images/docs) is *not* inline in the snapshot — content-addressed by SHA-256 hash, uploaded once,
downloaded on demand (`toCloudShape`/`fromCloudShape` in `sync.js`). `pollPull` has an explicit guard
against a blank/empty remote snapshot silently wiping real local data (see the long comment around
`remoteLooksBlank`) — read that before changing pull logic.

`license.js` is a thin client for `server/worker.js`: activation keys are device-bound (seat limits), no
user accounts. `LICENSE_SERVER` at the top of `license.js` toggles enforcement — empty string = dev mode
(no activation required, sync disabled). `popup.js` never calls the server directly; it only sends
`activate`/`deactivate`/`syncNow`/`admin*` messages to `background.js` and reads results off
`getState().license`/`.cloudSync`.

`server/worker.js` is a single-file Cloudflare Worker over one KV namespace (`LICENSES`), storing license
records, `sync:<key>` snapshots, and `media:<key>:<hash>` attachments (see its own header comment for the
full endpoint list and KV layout).

### External API surface (`background.js`, bottom section)

`chrome.runtime.onMessageExternal`/`onConnectExternal`, allow-listed to one sister extension
("Nuskomate", id in `NUSKOMATE_EXTENSION_ID`) via `externally_connectable` in `manifest.json`. Exposes a
generic openChat/sendText/sendMedia/mentionInChat/getMessageMedia surface reusing the same
`ensureWaTab`/`pingContentScript`/`sendToTab` plumbing as the internal UI — deliberately generic, no
awareness of what the external caller does with it. Connection/activity is tracked in
`chrome.storage.local.nuskomateStatus` (`setNuskomateStatus()`, updated on connect/disconnect/relay/
external request) and surfaced in `getState()` — rendered as a status dot in the popup's Settings tab
(`renderNuskomateStatus()` in `popup.js`) so it's visible whether the bridge is actually connected,
purely read-only/informational.

Sibling repo `../nuskoMate` is the actual Nuskomate extension consuming this API
(`modules/whatsapp-automation.js` holds its side of the port connection). Its own dev workflow
(per its README) is `node build.js` → load `dist/` unpacked; **`dist/` is not auto-rebuilt**, so a stale
`dist/` there is a common reason this bridge silently does nothing — check `dist/modules/` actually
contains `whatsapp-automation.js`/`whatsapp-pipeline.js` before assuming a bug on this side.

### `popup.js` (~5500 lines, no framework — vanilla DOM manipulation)

Single file, organized in `// ============ SECTION ============` blocks in this order: toast/confirm
dialog helpers → module-level `STATE` (mirrors `background.js`'s `getState()` result) → theme/master
switch/side-panel/privacy-blur UI → tabs → **Messages** (compose form, country-code + live chat-search
picker widget `createChatPickerWidget`, item list rendering, `buildSendPanel` — the Send-panel with
Send-now/Schedule modes shared by both a message row and the Campaigns tab) → **Campaigns** (a view over
`message.schedules`, not a separate entity — `renderCampaignsList`/`campaignNewToggleBtn` reuse
`buildSendPanel`'s schedule editor) → **Auto-reply tab** (a view over `message.autoReply`) → **Lists** →
**Contacts** (incl. the contact-detail modal) → **Log** → **Settings** → **Activation** → **Keys**
(master-key-only admin tab, hidden unless `license.master`) → custom tooltips → header logo SVG.

Every popup→background call goes through the `call(action, payload)` helper at the top (thin wrapper
around `chrome.runtime.sendMessage`); `background.js`'s big `switch (msg.action)` in its
`onMessage` listener is the authoritative list of valid actions.

`popup.html?panel=1` is the same page reused for side-panel mode (`chrome.sidePanel`), toggled via
`settings.uiMode` and `applyUiMode()` in `background.js`.
