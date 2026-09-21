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
- **Bump `version` in `manifest.json` with every change that ships** (patch bump for a fix, minor for a
  new feature) — this is a hard rule here, not a suggestion: `chrome://extensions`' card only shows the
  version number, not a build hash, so it's the one way to visually confirm you reloaded the build you
  actually meant to test rather than a stale one.
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

`chrome.runtime.onMessageExternal` only (no `onConnectExternal`/persistent port anymore — see below),
gated by a **user-editable allow-list** (`chrome.storage.local.externalClients`, `{id, name}[]`, edited in
Settings → External API, local-only/never synced; seeded from `DEFAULT_EXTERNAL_CLIENTS` = Nuskomate + CRM
Bridge until first edited). `manifest.json`'s `externally_connectable.ids` is deliberately `["*"]` because
Chrome fixes that list at install time and can't be changed at runtime — the real gate is the sender-id
check at the top of the `onMessageExternal` listener (an unlisted id gets an error reply telling it to be
added), so **never remove that check**. Every listed extension gets every live-message push and can call
every action below (plus a bare `ping`); a send's Log entry is labeled with the caller's name. Exposes a generic
openChat/sendText/sendMedia/mentionInChat/getMessageMedia/getChats request/response surface reusing the
same `ensureWaTab`/`pingContentScript`/`sendToTab` plumbing as the internal UI — deliberately generic, no
awareness of what the external caller does with it. `getChats` takes no payload and returns every
group/contact/community plus every open 1:1 (including numbers not in the address book) as
`{waId, name, isGroup}[]` — it's the same two-scope `listChats` call (`scope:'all'` +
`scope:'chats', contactFilter:'all'`, merged by waId) popup.js's own `fetchLiveChatMap()` already makes for
the Lists tab's live re-scan, just exposed externally and reshaped to Nuskomate's field names; Nuskomate
does its own name-search filtering client-side against the result rather than this file taking a query
param. The push direction (new WhatsApp message → each listed extension,
from `externalRelayMessage`) is a one-shot `chrome.runtime.sendMessage(client.id, {type:
'new-message', ...})`, NOT a long-lived port — a port was tried first but doesn't reliably survive either
side's MV3 service worker being suspended after ~30s idle, which produced a connect/disconnect cycle
roughly every 30 seconds in practice with a real risk of a message landing in the gap and being silently
dropped (the old code only relayed `if (nuskomatePort)`). A one-shot message doesn't have that failure
mode: Chrome wakes a suspended service worker to deliver it regardless. Reachability is tracked in
`chrome.storage.local.externalStatus` (per client id; `setExternalStatus()`, updated whenever a
push/ping/request happens, keyed by whether it actually got a response — `reachable`/`lastPingAt`/
`lastMessageOk`/`lastMessageAt`/`lastRequestAt`) and surfaced in `getState()` — rendered as one status row
per extension in the popup's Settings tab (`renderExternalClients()` in `popup.js`, with Test/Remove buttons
and an add-by-ID form). A one-shot reachability ping (`{type:'ping'}`, `pingExternalClient()`) fires for
every listed extension each time this service worker itself starts (and on Test/Add), since there's no
persistent connection to check the state of at any other time.

Sibling repo `../nuskoMate` is the actual Nuskomate extension consuming this API
(`modules/whatsapp-automation.js` holds its side — a single `chrome.runtime.onMessageExternal` listener,
no port). **Verified directly (2026-09-17): Nuskomate is loaded unpacked from its source root, not from
`dist/`** — its `dist/` folder is stale/unused for the developer's own testing (confirmed by the popup's
own version number matching source, not the older version baked into `dist/`). Don't assume a stale
`dist/` is the reason this bridge isn't working; check that Nuskomate's actual loaded copy (wherever
Chrome points at it) has been reloaded since any change to its bridge code instead.

### Incoming activity feed (the "Incoming" tab)

`page-bridge.js`'s `installExternalRelayHook()` already subscribes to `WPP.on('chat.new_message', ...)`
completely unfiltered (fromMe included, every message type) and relays every event through
`content.js` → `background.js`'s `externalRelayMessage` case — originally built only to forward to
Nuskomate. `appendIncomingActivity()` now also writes every one of those events (capped at 500,
`chrome.storage.local.incomingActivityLog`, written directly — never through `setState()`/sync, same
reasoning as `autoReplyCooldowns`) so the popup has proof the extension is actually receiving live events
from every chat, independent of whatever (if anything) consumes them. Rendered by `renderIncomingTab()` in
`popup.js`. Media is metadata-only in the feed (type/caption, no bytes) — `fetchMessageMedia` is a new
plain (non-external) action that pulls one attachment on demand via the same `getMessageMedia`
page-bridge action Nuskomate's API and chat export both already use.

Because this key can write several times a second in an active chat, `popup.js`'s
`chrome.storage.onChanged` listener special-cases it (alongside `SELF_APPLIED_STORAGE_KEYS`) to patch
`STATE.incomingActivityLog` and call only `renderIncomingTab()` instead of the full `refresh()` every
other storage key triggers — don't add more chatty per-message storage keys without the same guard, or
the whole popup gets sluggish while that tab isn't even open.

Each card also has an inline **reply** box (`incomingReplyOpenId`/`incomingReplyDraft` in `popup.js`,
only one open at a time) that reuses the compose form's own `.textarea-wrap`/`.textarea-toolbar` markup
but stripped to just Aa/attach/send — sends via the same `sendNowToChat` action the quick-send box uses
(`{waId, name, items}` → `runCampaign` with an explicit target), not through `runChatExport` or anything
Incoming-specific. Since that same `chrome.storage.onChanged` handler above would otherwise blow away a
mid-typed reply every time unrelated traffic arrives from any other chat (`renderIncomingTab()` rebuilds
the whole list's `innerHTML`), it skips calling `renderIncomingTab()` entirely while `incomingReplyOpenId`
is set — `STATE` still updates underneath, the view just catches up the moment the reply sends or closes.

**Known fixed bug**: `installExternalRelayHook`/`installIncomingMessageHook` in `page-bridge.js` used to read
a media message's text as `msg.body || msg.caption`. `.body` on a media message isn't user-facing text —
for WhatsApp Status/Story updates specifically, it turned out to hold raw base64-looking internal data,
which showed up verbatim as the "message text" in the Incoming feed. Fixed to only trust `.body` for an
actual `chat`-type (plain text) message, and `.caption` (only) for anything with a `mimetype` — same rule
`getChatExportData` already used, just not applied here. Also fixed: a Status update's `chatName` used to
show the literal shared broadcast id ("status@broadcast"), telling you nothing about who posted it — now
resolved via `msg.author` (same field/lookup `getChatExportData` uses for a group message's real sender)
and stored as `isStatus`/`authorWaId` on the activity entry, which the Incoming tab's Open/Reply buttons
target instead of the unusable broadcast id. And: `getMessageMedia` in `page-bridge.js` used to open a
blank new tab for some attachments (again, mostly Status media) — `WPP.chat.downloadMedia()`'s Blob can
come back with an empty `.type`, and since a data: URL's mimetype is baked in at `FileReader.readAsDataURL`
time, an empty Blob type became an empty/wrong mimetype baked into the URL, which the browser then can't
render. Fixed by guessing a mimetype from the message's own type and re-wrapping the Blob with it *before*
reading, plus an explicit error (instead of a silent blank result) when the download comes back with zero
bytes — which happens on some Status attachments and needs live debugging (Errors panel) to chase further
if it recurs, same as the `WPP.onReady` bug below.

**Known fixed bug**: `waitForWppReady()` in `page-bridge.js` used to call `window.WPP.onReady(callback)` to
wait for WhatsApp Web to finish loading. Confirmed via a real crash (Edge's extension Errors panel) that
`WPP.onReady` is not reliably a function on every wa-js build/WhatsApp Web version pairing — calling it
threw `"window.WPP.onReady is not a function"` as an immediate uncaught rejection, silently killing
`installIncomingMessageHook`/`installExternalRelayHook` (auto-reply and the Incoming feed) before they
ever got to their actual listener registration. This was invisible via the "ping" action's own status
check because that one only runs after WhatsApp Web has already loaded — `WPP.isReady` is already `true`
by then, so it returns on the fast path without ever calling `.onReady()` — but the message hooks install
at page load, when `isReady` still legitimately is `false`, so they were the ones actually reaching (and
crashing on) that call, every single time, on every reload. Fixed by rewriting `waitForWppReady()` to poll
`WPP.isReady` on a 250ms interval instead of depending on `.onReady()` at all — no dependency on that API
existing. `installExternalRelayHook` also fires a one-shot `relayHookReady` signal (`wa-ext-notify` →
`content.js` → `background.js` → `chrome.storage.local.relayHookStatus`) so the Incoming tab shows a real
installed/not-yet status instead of inferring it from traffic alone — an empty feed and a silently-broken
hook otherwise look identical. If this regresses again, check the extension's **Errors** button in
chrome://extensions/edge://extensions first — it captures uncaught exceptions from every context
(background, content scripts, page-bridge's MAIN-world script) with full stack traces, far more precise
than guessing from console noise shared across every extension on the page.

### Visible/copyable WhatsApp chat IDs

Every place a chat gets picked or listed (the live search dropdown in `createChatPickerWidget`, the Lists
tab's fetched-chats checklist, the Contacts tab's list rows and detail modal) shows the real `waId` (e.g.
`1234567890@c.us`, `...@g.us` for a group) plus a one-click copy button — `copyToClipboard()` is the shared
helper for all of them. Added because nothing in the popup surfaced this before, and external tools (the
Nuskomate API) need exactly this id, not a display name or phone number.

### Chat export

Header "Export chat" button (`exportChatBtn`/`renderExportChatButton()` in `popup.js`) exports whatever
chat is open in the WA tab right now. `page-bridge.js`'s `getChatExportData` action pulls the full history
via `WPP.chat.getMessages(chatId, {count:-1})` and returns clean per-message records (text/caption inline;
media messages carry `msgId`/`mimetype`/`origFilename` instead of the bytes). `background.js`'s
`runChatExport()` then downloads each attachment one at a time through the existing `getMessageMedia`
action and `chrome.downloads.download()`s it under `Downloads/WA-Export/<chat>/`, finishing with a
`chat.json` — reusing `activeRuns` for progress (so the button shows the same percentage-ring UI as a
"send to current chat" button) and a `chrome.downloads` permission rather than the File System Access
API's `showDirectoryPicker()` (which needs a real user gesture inside the WhatsApp Web page itself — a
popup click relayed over `chrome.runtime` messaging doesn't carry that through). Output shape intentionally
mirrors the third-party "WhatsJSON" extension for familiarity.

### Fancy text styles

Compose toolbar's **Aa** button (`msgFontStyleBtn`/`renderFontStyleControl()`/`FONT_STYLES` in `popup.js`)
is pure Unicode character substitution (Bold/Italic/Script/Fraktur/Double-struck/Monospace/Fullwidth/
Circled/Strikethrough/Underline) applied to the textarea's current selection (or its whole value) via
`styleRange()`/`styleCombining()` — no server or background.js involvement at all, it's a client-side
string transform. Deliberately not real WhatsApp markdown formatting (`*bold*` etc.) — see the block's own
comment for why bold/bold-italic/bold-script/bold-fraktur variants were picked over their plain
counterparts (avoids well-known "holes" in the Unicode Mathematical Alphanumeric block).

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
