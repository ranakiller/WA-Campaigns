# WhatsApp Message Scheduler (Chrome Extension)

A personal-use Chrome/Edge extension for **your own** WhatsApp groups and
contacts: fetch chats straight from WhatsApp Web's own data (not screen-
scraping), organize them into reusable named lists, save a library of
text/image/document messages, and schedule any saved message to send
automatically — scheduling lives directly on the message itself, there's no
separate "campaign" object to manage.

## ⚠️ Please read before using

WhatsApp's Terms of Service prohibit automated/bot-driven sending through
WhatsApp Web, even to your own contacts. This extension calls WhatsApp Web's
own internal send functions (see "How it works technically" below) on your
behalf. WhatsApp's abuse detection can flag accounts that send scripted,
repetitive messages — this can lead to temporary restrictions or, in
repeated cases, a ban of your number. Using this only for your own groups
(not cold-messaging strangers) significantly lowers the risk profile, but
does **not** eliminate it.

Sending anything — a one-off "Send now" or a schedule — is locked behind a
one-time consent checkbox on the Settings tab for this reason: you have to
explicitly confirm you're only targeting your own groups/contacts first.

Ways to reduce risk if you use it anyway:
- Keep daily volume modest (a handful of sends a day, not hundreds).
- Leave delay/jitter settings (Settings tab) turned on — don't set them to 0.
  The defaults (20–45s between messages, 30–60s between lists) are on the
  conservative side on purpose; general guidance for reducing spam-detection
  risk on personal WhatsApp automation suggests staying well above a few
  seconds per send. Treat these as a reasonable starting point, not a
  guarantee — WhatsApp doesn't publish exact thresholds.
- Prefer **Paced** sending mode over **Fast** — it applies your configured
  delay range between every send instead of a bare minimum gap.
- Don't send the exact same message to a large number of chats back-to-back.
- If you need this for a real business use case at scale, look into the
  official **WhatsApp Business Platform / Cloud API** instead — it's built
  for scheduled and templated outbound messages with proper terms of use.

This extension is for personal/sideloaded use only — it is **not** intended
for the Chrome Web Store (automating WhatsApp Web this way would not pass
store review, for the same ToS reasons noted above).

## What it does

- **Messages tab** — a **Serial number** field (optional; suggests the next
  unused number by default) controls display order in the Saved Messages
  list, ascending, with unnumbered messages sorted after numbered ones. This
  only affects
  ordering/display, not how sending itself works. Each saved message also
  has **▲/▼** buttons to reorder it directly in the list, without typing a
  number by hand — this renumbers every message to a clean 1..N first, so
  it works sensibly even if some were unnumbered. A saved message is an
  ordered sequence of **items**:
  add a text item (write it, tap **+**), or attach one or more images/
  documents in a single browse — each becomes its own item with its own
  caption (e.g. 10 airline package images, each with a different caption,
  all under one saved message). Reorder items with the ▲/▼ buttons, or type
  a number directly into an item's own number box to jump it straight to
  that position — either way, items are sent in this exact order, so
  reordering here is reordering the send order. Remove items individually,
  or clear all of them at once with the trash icon next to the item count.
  When
  sent, every item for a chat goes out back-to-back instantly (no delay
  between items in the same chat). Your configured delay only applies when
  moving on to the *next chat*. A standalone 1-line "➖➖➖" separator
  message can be sent *between* items — never after the last one, and never
  for a single-item message — so a multi-item chat still reads clearly as
  separate threads; this isn't a message-level setting, it's chosen at
  send time (see below), since the same message might go out with or
  without separators depending on how it's sent. A "Use file names as
  captions" button fills in each attached file's own name (extension
  stripped) as its caption, for any media item whose caption is still empty
  (won't overwrite one you've already typed). The **Aa** button on the
  compose textarea's own toolbar opens a **fancy text style** picker —
  Bold, Italic, Bold Italic, Script, Fraktur, Double-struck, Monospace,
  Fullwidth, Circled, Strikethrough, Underline — each one rewrites the
  currently selected text (or the whole box, if nothing's selected) into a
  different set of Unicode characters that look that way anywhere, WhatsApp
  included. This is cosmetic character substitution, not real formatting —
  unlike WhatsApp's own `*bold*`/`_italic_`/`~strikethrough~`/`` ```monospace``` ``
  markdown syntax (still typed by hand, this doesn't add buttons for that),
  a styled character can't be un-styled by re-typing it as plain text; copy
  the original elsewhere first if you might want it back. Each saved message also has a
  **Send** icon that opens a panel with two modes, **Send now** and
  **Schedule** — everything about who a message goes to and when lives
  right there on the message itself, there's no separate campaign to build.
  **Send now** fires it off immediately — at one or more saved lists
  (checkbox for the separator sits right next to Send now/Cancel — it
  remembers its last-used state across popup opens), or via the send-icon
  button at the top-right of the panel (hover for its tooltip) which sends
  the whole message to whatever chat is open right now in the WhatsApp Web
  tab, no list needed. **Schedule** turns the same list picker into a saved,
  recurring (or one-off) auto-send — see the bullet on scheduling below. For
  a multi-item message, one shared item list
  serves the rest: each item has its own checkbox (all checked by default,
  with a "Select all" toggle next to that same top-right button)
  controlling what's included in a list send, and its own ▶ button to send
  just that one thread to the currently open chat — an image/PDF/document
  item also gets an "open in a new tab" icon right before that button, to
  preview the actual file before sending it. Each list in the checklist has
  its own ▾ button that expands a per-chat checklist — every chat starts
  unchecked, nothing is picked until you explicitly pick it. Checking the
  list's own checkbox selects every one of its members at once; checking
  individual chats within it (without touching the list checkbox) selects
  just those — either way, having at least one chat selected is what makes
  that list part of the send, shown as the list checkbox going fully
  checked, partially (indeterminate), or back to empty. The list's own label
  shows a live "(selected/total)" count. These selections are saved per
  message and survive closing and reopening the popup, not just a
  re-render.
  The item checkboxes control both what a list send includes and what the
  whole-message "send to current chat" button sends — only checked items go
  out either way. A list send shows a live progress bar (sent/failed/pending,
  %) under the panel while it runs. Sending to the current chat — whole
  message or a single thread — skips that panel-wide progress bar instead:
  the button you clicked turns into a small round percentage ring in place
  of its icon until the send finishes, without disturbing the rest of the
  panel. Hover that ring and click it (with a confirm) to stop the send
  early — since there's no progress bar there to hold a pause/stop button.
  Edit or delete any saved message; each tracks when it was last
  sent. The compose form is also a **persistent draft** — an unsaved
  label/text/items survives closing the popup and picks back up next time
  you open it, until you Save or Cancel.
- **Lists tab** — open web.whatsapp.com in a normal tab, choose **Groups**,
  **Contacts**, **Communities**, **Chats**, or **All**, then click **Scan**:
  - Groups comes from every group you're a member of.
  - Contacts comes from your actual WhatsApp contacts (the synced phone
    address book), not just people you happen to already have a chat open
    with. Contact entries show the phone number alongside the name.
  - Communities comes from the community wrapper chats themselves (see
    "Known limitations" for how these relate to their announcement group,
    which shows up under Groups instead).
  - Chats comes from your individual (1:1) conversations, whether or not the
    other person is a saved contact — useful for reaching people who've
    messaged you but were never saved. A filter next to the scan buttons
    narrows it to **saved contacts only** or **non-contacts only**; unsaved
    entries also carry a "not saved" badge in the results.
  Fetched chats **persist** until you explicitly clear them (**Clear
  fetched**) — closing the popup doesn't lose a scan you haven't saved into
  a list yet. Every fetched chat row shows its real **WhatsApp chat ID**
  (e.g. `1234567890@c.us` for a contact, `123456789-987654321@g.us` for a
  group) with its own copy button — a group has no phone number at all, so
  this is the only way to get its unique id out of this extension, e.g. to
  hand to an external tool like Nuskomate (its `sendText`/`sendMedia`/
  `openChat` all need exactly this id, not a display name). The same id +
  copy button shows up anywhere else a chat is picked or listed — the
  quick-send/manual-add live search dropdown (Messages, Lists, Contacts
  tabs), and each row/detail view on the **Contacts** tab. Search the
  fetched chats, use Select all/Deselect all to work
  through them quickly, and save your picks as a **named list** — e.g.
  "Family groups", "Work team", "Customers". You can also add an individual
  contact by phone number, or **import from a CSV**. There's no way to look
  a group up by name (no API resolves a name to a group — only scanning,
  since you have to already be a member), but the CSV import isn't limited
  to contacts: a plain "number, name" list with no header row builds a chat
  id from each number instantly, with no live check at import time — every
  send already resolves/verifies its own target chat as its first step
  regardless (`sendRawMessage`'s `assertFindChat`), so a number that turns
  out not to be on WhatsApp just fails then, per-chat, logged like any other
  send failure, rather than the whole import waiting on one-by-one checks it
  doesn't actually need. The same Name/Type/ID-or-number shape
  **Export fetched chats to CSV** (the small grid icon, also next to each
  saved list) produces is *also* accepted, groups included — those rows
  already carry the group's real id, so re-importing them (after trimming
  the file down to whichever rows you actually want) works the same way, no
  lookup either. An end summary shows added / already had it. Imported
  chats land in "Fetched chats" pre-selected, same as manual add, ready to
  search/deselect and save as a list. Build as many lists as you like, and
  editing one re-shows its saved
  members even without rescanning. Exporting groups also checks (fresh,
  every export — not cached) and adds two columns: whether you're an admin
  of that group, and whether the group itself is admin-only/announcement
  mode — both blank for non-group rows. The admin-only column needs a
  full group-metadata fetch that can fail if even one group elsewhere in
  the account has a broken session (see "Known limitations"); when that
  happens it comes back blank for every group rather than failing the
  export outright, and the admin column (checked per group individually)
  is unaffected either way.
- **Scheduling a message** (the **Schedule** mode inside a message's Send
  panel, Messages tab) — pick one or more saved lists (same checklist as
  Send now) and choose **When**:
  - **Daily time(s)** — add one or more HH:MM times; the schedule runs at
    every one of them, every day (e.g. 9am, 1pm, 6pm).
  - **Repeat interval** — runs every N minutes/hours, or set "N times a
    day" instead and it works out the evenly-spaced interval for you.
    Optionally restrict it to active hours (e.g. only between 9am–9pm) so
    it doesn't fire in the middle of the night.
  - **One-time (multiple)** — add one or more specific date/times; each
    runs once, independently, then drops off the list.
  Delay defaults to the Settings tab's settings — untick **Use default delay**
  to set a custom delay range (between messages, and before starting the
  next list) just for this schedule. A checkbox next to **Save schedule**
  (remembers its last-used state across popup opens) controls whether that
  schedule's multi-item sends get a separator between threads (see Messages
  tab above). A message can hold **more than one schedule** — e.g. the same
  message going to one list every morning and a different list on Fridays —
  each with its own optional label to tell them apart; a "🕒N" badge on the
  message row shows how many are currently active. Every schedule for a
  message is listed right there in its Send panel, with its own
  pause/resume, run-now, edit, and delete, and its own live progress bar
  whenever it's actively running (scheduled or via Run now).
- **Log tab** — history of what was sent, when, to which chat, and whether
  it succeeded or failed. A search box (with a "✕" to clear it) matches
  the message/schedule name, chat name, message text, *and* the shown
  date/time — so
  searching "8/27", "1:13", or "pm" filters by when it ran, too. A status
  filter (success/error) narrows it further. Both remember their last-used
  value across popup opens. **Clear log** wipes it. Every successfully sent
  message gets a **delete-for-everyone** button (WhatsApp's own "delete for
  everyone," not just deleting it from this log) — and if it was part of a
  multi-chat send, a bulk "Delete all N for everyone" button appears once for
  that whole send too. With the search box or status filter narrowing the
  list down, that same bulk button instead targets exactly what's currently
  filtered/visible — deleting only those, not the rest of whatever send(s)
  they came from. WhatsApp only allows this within a limited time after
  sending; past that (or if a chat's already had it deleted) that one is
  logged as failed and the rest of a bulk delete still proceeds rather than
  stopping. A live progress bar (with the same pause/reset controls as a
  send) shows while a delete is running. Deletes are paced a few seconds
  apart, one message at a time — WhatsApp's own `deleteMessage` API does
  technically accept a batch of message ids, but it turns out that's not a
  single combined command, just an internal loop with no pacing of its own,
  so batching made deletes *less* reliable, not faster, and isn't used here.
- **Incoming tab** — a real-time feed of every message this extension's
  live WhatsApp hook has actually seen arrive, across every chat, whether
  or not anything (auto-reply, the Nuskomate relay) does something with it.
  This exists to *prove* the extension is really receiving live events —
  text, images, video, voice notes, documents, stickers — from every chat,
  not just to show what it sent. Search by chat name/text, filter by
  message type, and toggle whether your own sent messages (fromMe) show up
  too — they're included by default, since seeing them is part of
  confirming the pipe carries everything, not just what's addressed to you.
  Media is **not** downloaded automatically (that would mean fetching every
  photo from every chat live, which nothing needs by default) — each media
  entry gets its own **View** button to pull that one attachment on demand
  and open it in a new tab. Entries are capped at the most recent 500 and
  never leave this device (not part of cloud sync); **Clear** wipes the
  local record only, nothing on WhatsApp itself. A small status dot at the
  top ("Live hook active · installed…") reflects whether the underlying
  WhatsApp-page hook actually installed on this tab, independent of
  whether any message has arrived yet — an empty feed and a silently-broken
  hook otherwise look identical.
- **Settings tab** — the consent checkbox, jitter (± minutes around a fixed
  scheduled time), default delay ranges, a light/dark/system appearance
  toggle matching WhatsApp Web's own theme, and an optional message
  header/footer. When set, the header and footer are added to *every*
  item/thread of every sent message — text items in the text, media items
  in the caption — each separated from that item's own content by a blank
  line. Leave either empty to skip it. An **External API (Nuskomate)** card
  shows a live green/red/gray dot for whether the allow-listed Nuskomate
  extension (see "How it works technically" below) was actually reachable
  the last time this extension pushed it a message or pinged it, plus a
  relative timestamp for its most recent activity — purely informational,
  this extension only initiates the once-per-startup reachability ping
  toward Nuskomate, nothing else.
- **WhatsApp Status** (under the header title) — a glowing dot, checked
  fresh every time the popup opens rather than cached: green means a send
  would actually go through right now, red means it wouldn't (no
  `web.whatsapp.com` tab open, or the page/its content script isn't
  ready — e.g. right after reloading the extension, an already-open tab's
  content script is orphaned until that tab itself is reloaded). This is the
  same readiness check a real send performs, just surfaced up front instead
  of only discovered after clicking Send and getting an error.
- **Export chat** (header, download-arrow icon) — exports whichever chat is
  currently open in the WhatsApp Web tab: every message as one clean record
  in a `chat.json` (sender, name, timestamp, type, text/caption), plus every
  photo/video/document/voice-note saved alongside it as its own file — all
  under `Downloads/WA-Export/<phone number> - <name>/`. Read-only — this
  never sends or deletes anything, it only reads history WhatsApp Web
  already has loaded. The button itself turns into a small percentage ring
  while it runs (same as a "send to current chat" button), click it again
  to stop early; a toast reports the final message/file count when it's
  done. A long chat's first load can take a little while — WhatsApp Web has
  to page in its entire history before this can even start.
- **Master on/off switch** (top-right, next to the appearance toggle) — an
  instant kill switch. Turning it off blocks any new send from starting and
  stops whatever's currently running, checked before every single item (not
  just when a send starts) so it takes effect within one send, not
  after the whole thing finishes. A red banner shows while it's off.
- Any active send shows a live **progress bar** (sent/failed/
  pending, %) with its own **Pause/Resume** button — pausing waits before
  the next item rather than stopping outright, so you can resume right
  where it left off — and a **Reset** button to abandon a run outright
  (typically one you paused and don't want to finish). Reset only stops
  sending the rest; it doesn't re-send to chats already reached.
- The popup reopens on whichever tab you last had open.
- **An activation key is required** — a fresh install shows an "Activate to
  continue" screen before anything else. There are no accounts or sign-in:
  you paste the key you were given, and that's it. Click the initial-letter
  avatar in the header to see the key's details, toggle cloud sync, or
  deactivate this device. (With `LICENSE_SERVER` left empty in
  `license.js` — dev mode — no activation is needed and sync is off.)

## Activation keys & cloud sync (Cloudflare)

Keys and synced data live in a tiny Cloudflare Worker + KV namespace you
deploy yourself — see **`server/README.md`** for the one-time setup (free
tier), creating your master key, and the exact storage layout. Nothing in
`server/` ships inside the extension.

- **Keys are device-bound.** Each install gets a random device id; a key
  works on a limited number of devices (*seats*, default 2) and the server
  rejects any beyond that. The extension re-checks its key every 15 minutes
  in the background and every time the popup opens, so a revoked/expired key
  (or a device an admin reset) stops working within minutes — scheduled
  sends included. A key holder with `master: true` gets a **Keys** tab in the
  popup to create / edit / reset devices / revoke / delete keys.
- **Cloud sync** — turn on **"Sync messages, lists, log & settings to the
  cloud under this key"** (header avatar → panel) and those four things are
  kept as one snapshot under your key, so a second device activated with the
  same key gets the same data. Off by default. A message's schedules travel
  with it as part of the message itself — **note that means both devices
  will fire them**; keep a schedule's message on one device, or disable it on
  the other.
- **Push is automatic but rate-limited**: a local change uploads ~2s later,
  never more than once per 30s per device (a running campaign writes to the
  log every send, and KV's free tier is 1,000 writes/day). **Pull** is by
  polling once a minute (`chrome.alarms` — the only thing that reliably
  survives Manifest V3 idling the service worker out) plus immediately when
  the popup opens; "Sync now" in the panel does both on demand. Turning sync
  on does one pull first, so a new device joining a key doesn't start by
  overwriting the cloud copy with its own empty state.
- **Conflict handling is whole-snapshot, last-write-wins** by a plain
  timestamp — not a field-by-field merge. Editing on two devices within the
  same minute means whichever push lands later wins outright. For one person
  mostly on one device at a time, that keeps the engine simple and
  predictable. The sync toggle, the master on/off switch and the theme are
  per-device and never overwritten by a pull.
- **Media (images/PDFs/docs)** isn't inline in the snapshot — each attachment
  is stored separately, content-addressed by a hash of the file, so the same
  attachment reused across messages/devices only ever uploads once (up to
  24 MB each; the extension warns above 15 MB anyway). A pull is
  all-or-nothing: if an attachment can't be downloaded, the previous local
  copy is kept and it retries on the next poll.

## How it works technically

Earlier versions of this extension scraped the rendered chat list DOM and
simulated clicks/typing to send — which turned out to be unreliable
(WhatsApp's virtualized list only renders what's on screen, a simulated
click doesn't always register, and duplicate chat names can't be told apart
by their visible text alone). This version instead uses the same technique
established WhatsApp Web automation libraries use (e.g.
[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js),
[WPPConnect](https://wppconnect.io/)): reaching into WhatsApp Web's own
internal data/functions instead of the rendered page.

- **`vendor/wppconnect-wa.js`** is the prebuilt
  [`@wppconnect/wa-js`](https://github.com/wppconnect-team/wa-js) library
  (Apache-2.0, © WPPConnect Team — license notice kept alongside it in
  `vendor/wppconnect-wa.js.LICENSE.txt`). It's injected into the page's own
  JS context (Manifest V3 `"world": "MAIN"`) where it exposes a `window.WPP`
  object wrapping WhatsApp Web's real chat list, contact list, and
  send-message functions — the same ones the WhatsApp Web UI itself calls.
- **`page-bridge.js`** (also injected into the page's MAIN world) waits for
  `WPP.isReady` and answers requests like "list all chats" or "send this
  text/file to this chat id" by calling `WPP.chat.list()` /
  `WPP.chat.sendTextMessage()` / `WPP.chat.sendFileMessage()` directly — no
  DOM involved. **Export chat** uses the same technique for the currently
  open chat's full message history (`WPP.chat.getMessages(chatId, { count:
  -1 })`) and its attachments (`WPP.chat.downloadMedia()`, already used for
  the external API's `getMessageMedia`); `background.js` then saves the
  result via `chrome.downloads.download()` rather than the OS-level folder
  picker some similar tools use, since that picker needs a real user
  gesture inside the WhatsApp Web page itself, which a click relayed over
  from this extension's popup doesn't carry.
- **`content.js`** runs in the extension's isolated content-script world (it
  can't see `window.WPP` directly — isolated and MAIN worlds don't share JS
  objects). It's a thin relay: forwards requests from `background.js` to
  `page-bridge.js` via `CustomEvent`s on `document` (which both worlds can
  see, since they share the same page), and relays the response back.
- **`background.js`** is the scheduler and data owner: `chrome.alarms` wake
  it up at the right time, it makes sure a WhatsApp Web tab is open, and it
  drives each schedule's targets (looping lists → chats, applying delays,
  logging results) by real WhatsApp chat ID (`waId`, e.g. `1234567890@c.us`
  or `123-456@g.us`) — not by display-name text, so two chats that happen to
  share a name can never be confused with each other. A schedule is just
  data living on the message it belongs to (`message.schedules[]`) — there's
  no separate top-level "campaign" entity; `chrome.alarms` names encode
  which message + schedule they belong to.
- Everything (messages incl. media and their schedules, fetched chats, lists,
  logs, settings, last-open tab) is stored locally via `chrome.storage.local`
  (with the `unlimitedStorage` permission, since saved images/documents can
  be a few MB) — that's still true regardless of sync. With cloud sync
  turned on (off by default — see "Activation keys & cloud sync" above),
  messages/lists/log/settings additionally get copied to the license
  server under this install's activation key; `fetchedChats` and
  in-progress run state stay device-local either way.
- **`license.js`** and **`sync.js`** are the activation + cloud sync layer —
  every call to the license server (`server/worker.js`, a Cloudflare Worker)
  happens in `background.js` (the service worker) over plain `fetch`, no
  SDK. `popup.js` never talks to the server; it sends
  `activate`/`deactivate`/`syncNow`/`admin*` messages and reads
  `license`/`cloudSync`/`settings.syncEnabled` off `getState()` the same way
  it reads everything else.
- **External API** — `manifest.json`'s `externally_connectable` allow-lists
  exactly one sister extension (Nuskomate, by its fixed extension id) to
  read incoming WhatsApp messages and send through this extension's own
  WhatsApp connection, instead of building its own. Handled entirely in
  `background.js` via one-shot `chrome.runtime.sendMessage`/
  `onMessageExternal` calls in both directions, reusing the same
  `ensureWaTab`/`pingContentScript`/`sendToTab` plumbing every internal
  action already uses — none of this extension's own scheduling, campaigns,
  contacts, or auto-reply behavior is affected either way. This used to be a
  long-lived `chrome.runtime.connect()` port for the push direction (new
  WhatsApp message → Nuskomate), but a Port doesn't reliably survive either
  side's MV3 service worker being suspended after ~30s idle — that produced
  a connect/disconnect cycle roughly every 30 seconds in practice, with a
  real risk of a message arriving in the brief gap being silently dropped.
  A one-shot message doesn't have that problem: Chrome wakes a suspended
  service worker to deliver it either way. The Settings tab's **External API
  (Nuskomate)** card is a read-only status light reflecting the most recent
  push or the once-per-startup reachability ping (see above); if it shows
  "not reachable," check that Nuskomate is actually installed/enabled and
  that whatever copy of it Chrome has loaded includes this bridge code
  (`modules/whatsapp-automation.js`'s `onMessageExternal` listener) — reload
  the Nuskomate extension after any change to its source. Every message
  Nuskomate actually sends (`sendText`/`sendMedia`/`mentionInChat`) is logged
  to the **Log tab** exactly like any other send, labeled `Nuskomate: <chat>`
  — searching "Nuskomate" there shows only these. A successful one gets the
  same **Delete for everyone** button as any other logged send, since it's
  logged with the same `waId`/`msgId` shape.

## Requirements

- You must be logged into WhatsApp Web (scan the QR code once, WhatsApp
  keeps you logged in) with **web.whatsapp.com open in a Chrome/Edge tab**
  at (or shortly before) the scheduled time. If no tab is open, the
  extension will try to open one automatically, but the very first login on
  a fresh browser profile still requires you to scan the QR code by hand.
- The computer/browser needs to be on and running for scheduled sends to
  fire — this isn't a cloud/server-side scheduler.
- Chrome/Edge 111+ (for Manifest V3 `"world": "MAIN"` content scripts).

## Installing (load unpacked)

1. Keep this folder somewhere permanent (don't delete it after installing —
   Chrome/Edge loads the extension directly from these files).
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Pin the extension (puzzle-piece icon in the toolbar → pin) for easy
   access.
6. Open a tab to `web.whatsapp.com` and log in if you haven't already.
7. Click the extension icon: build a list from the Lists tab, save a
   message, accept the consent checkbox on the Settings tab, then use that
   message's Send icon to send it now or schedule it.

**Upgrading from an older version of this extension:** lists saved before
this version won't carry their members forward correctly. Rebuild any
existing lists once: **Scan**, search/select, and re-save each list
(one-time cleanup).

**Upgrading from a version with a separate Campaigns tab:** any saved
campaign is migrated automatically, once, the first time this version loads
— it's moved onto the message it targeted as one of that message's
schedules (visible in that message's Send panel, under Schedule), and the
Campaigns tab is gone. Nothing needs to be rebuilt by hand for this one.

## Known limitations

- Sending still goes through your own logged-in WhatsApp Web session and is
  still automated — see the ToS warning above. The technique change (Store
  API instead of DOM scraping) makes sends land in the *correct* chat
  reliably; it does not change WhatsApp's own spam-detection risk.
- If WhatsApp updates WhatsApp Web internals in a way that breaks the
  vendored library, re-download the latest build from
  `https://unpkg.com/@wppconnect/wa-js/dist/wppconnect-wa.js` (and its
  `.LICENSE.txt`) into `vendor/` — the WPPConnect team tracks WhatsApp's
  changes upstream, so this is normally just dropping in a newer file rather
  than hand-patching selectors.
- "Add a contact by phone number" only works for individual contacts (a
  phone number can be turned into a WhatsApp chat ID; a group name can't).
  Groups are only added via **Scan open chats**.
- Media caption support depends on `WPP.chat.sendFileMessage`'s own
  `caption` option — very large files may be slow or rejected by WhatsApp's
  own upload limits, same as sending manually.
- On some accounts, WhatsApp Web's own internal code can throw `Cannot read
  properties of null (reading 'rotateKey')` — a Signal Protocol session
  issue on WhatsApp's end (seen e.g. right after linking WhatsApp Web on a
  new browser, before every chat's local session state has caught up), not
  something this extension causes. Scanning works around it by skipping
  metadata this extension doesn't need in the first place
  (`ignoreGroupMetadata`). Sending recovers from it reactively: if a send
  hits this error, it opens the chat once (`WPP.chat.openChatBottom`,
  mirroring a human clicking into it, which appears to be what actually
  establishes the session) and retries that one send, rather than doing it
  before every send and slowing all of them down for a problem most sends
  never hit. The admin-only-group check, Community redirect, and the CSV
  export's "Admin-Only Group" column *do* need real per-group metadata
  (unlike scanning) to do their job, so if metadata resolution crashes there
  (e.g. because some other group in the account has broken state, unrelated
  to the one actually being sent to or exported) it's treated as "couldn't
  check" — a send proceeds anyway rather than blocking on an unrelated
  group's problem, and a CSV export comes back with that one column blank
  for every group rather than failing outright.
- **Edge specifically** can put an inactive background tab to sleep
  ("Sleeping tabs", enabled by default) after a period of idle time — since
  this extension deliberately keeps the WhatsApp tab in the background so
  it never steals focus, it's exactly the kind of tab that targets. Chrome
  doesn't do this by default, which is why the same extension can behave
  differently between the two browsers. If sends start failing partway
  through a scheduled send on Edge with "WhatsApp Web tab is not ready," this is
  the likely cause — add `web.whatsapp.com` to Edge's "Never put these
  sites to sleep" list in `edge://settings/system`, or keep the WhatsApp
  tab pinned/active yourself during a run.
- A WhatsApp **Community** is implemented as a special group (the community
  wrapper) paired with a same-named announcement group underneath it. They're
  kept on separate scan scopes on purpose — the community wrapper only shows
  up under **Communities**, its announcement group only under **Groups** —
  so you can pick either or both without one silently masking the other as a
  same-named duplicate. WhatsApp itself refuses a direct message to the
  community wrapper (only its announcement group can receive one) but its
  rejection error names the correct group id — sends aimed at a Community
  are automatically retried against that announcement group instead of just
  failing, so adding a Community to a list still works as expected.
- **Admin-only groups**: WhatsApp doesn't error when a non-admin sends into
  a group with "Only admins can send messages" turned on (which includes
  every community announcement group by definition) — it just silently
  resolves without delivering anything, which used to show as a false
  "success" here too. This is checked before sending; if you're not an
  admin there, it's logged as an error and skipped rather than wasting a
  send that was never going to land.
- **Contacts** scope can be slow with a very large address book, since it
  reads your full synced WhatsApp contact list rather than just chats you
  already have open — Groups-only scans stay fast either way.
- Each contact can have both a phone-number identity (`@c.us`) and a
  privacy "LID" identity (`@lid`, WhatsApp's mechanism for masking a
  number from other people in shared groups) — the LID twin is filtered out
  of the Contacts scan so the same person doesn't show up twice under an
  identical name.
