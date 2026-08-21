# WhatsApp Message Scheduler (Chrome Extension)

A personal-use Chrome/Edge extension for **your own** WhatsApp groups and
contacts: fetch chats straight from WhatsApp Web's own data (not screen-
scraping), organize them into reusable named lists, save a library of
text/image/document messages, and schedule campaigns that send automatically.

## ⚠️ Please read before using

WhatsApp's Terms of Service prohibit automated/bot-driven sending through
WhatsApp Web, even to your own contacts. This extension calls WhatsApp Web's
own internal send functions (see "How it works technically" below) on your
behalf. WhatsApp's abuse detection can flag accounts that send scripted,
repetitive messages — this can lead to temporary restrictions or, in
repeated cases, a ban of your number. Using this only for your own groups
(not cold-messaging strangers) significantly lowers the risk profile, but
does **not** eliminate it.

The **Campaigns** tab is locked behind a one-time consent checkbox for this
reason — you have to explicitly confirm you're only targeting your own
groups/contacts before you can schedule anything.

Ways to reduce risk if you use it anyway:
- Keep daily volume modest (a handful of sends a day, not hundreds).
- Leave delay/jitter settings (Safety tab) turned on — don't set them to 0.
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

- **Messages tab** — a saved message is an ordered sequence of **items**:
  add a text item (write it, tap **+**), or attach one or more images/
  documents in a single browse — each becomes its own item with its own
  caption (e.g. 10 airline package images, each with a different caption,
  all under one saved message). Reorder or remove items before saving. When
  sent, every item goes to a chat one after another (with the same pacing as
  sending to a new chat) before moving on to the next chat — no need to run
  separate messages/campaigns manually. Each saved message also has a
  **Send** icon to fire it off immediately at one or more saved lists,
  without setting up a full scheduled campaign — the panel shows a live
  progress bar (sent/failed/pending, %) while it runs, updating in real
  time. Edit or delete any saved message; each tracks when it was last
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
  a list yet. Search the fetched chats, use Select all/Deselect all to work
  through them quickly, and save your picks as a **named list** — e.g.
  "Family groups", "Work team", "Customers". You can also add an individual
  contact by phone number. Build as many lists as you like, and editing one
  re-shows its saved members even without rescanning. The small grid icon
  next to "Fetched chats" (and next to each saved list) **exports to CSV**
  — Name / Type / ID-or-number columns, opens fine in Excel.
- **Campaigns tab** — pick a saved message, pick one or more saved lists,
  and choose **When**:
  - **Daily time(s)** — add one or more HH:MM times; the campaign runs at
    every one of them, every day (e.g. 9am, 1pm, 6pm).
  - **Repeat interval** — runs every N minutes/hours, or set "N times a
    day" instead and it works out the evenly-spaced interval for you.
    Optionally restrict it to active hours (e.g. only between 9am–9pm) so
    it doesn't fire in the middle of the night.
  - **One-time (multiple)** — add one or more specific date/times; each
    runs once, independently, then drops off the list.
  Delay defaults to the Safety tab's settings — untick **Use default delay**
  to set a custom delay range (between messages, and before starting the
  next list) just for this campaign. Pause/resume, run immediately, or
  delete any campaign. A campaign shows a live progress bar under it
  whenever it's actively running (scheduled or via Run now).
- **Log tab** — history of what was sent, when, to which chat, and whether
  it succeeded or failed. **Clear log** wipes it.
- **Safety tab** — the consent checkbox, jitter (± minutes around a fixed
  scheduled time), default delay ranges, and a light/dark/system appearance
  toggle matching WhatsApp Web's own theme.
- **Master on/off switch** (top-right, next to the appearance toggle) — an
  instant kill switch. Turning it off blocks any new send from starting and
  stops whatever's currently running, checked before every single item (not
  just when a campaign/send starts) so it takes effect within one send, not
  after the whole thing finishes. A red banner shows while it's off.
- Any active send or campaign shows a live **progress bar** (sent/failed/
  pending, %) with its own **Pause/Resume** button — pausing waits before
  the next item rather than stopping outright, so you can resume right
  where it left off.
- The popup reopens on whichever tab you last had open.

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
  DOM involved.
- **`content.js`** runs in the extension's isolated content-script world (it
  can't see `window.WPP` directly — isolated and MAIN worlds don't share JS
  objects). It's a thin relay: forwards requests from `background.js` to
  `page-bridge.js` via `CustomEvent`s on `document` (which both worlds can
  see, since they share the same page), and relays the response back.
- **`background.js`** is the scheduler and data owner: `chrome.alarms` wake
  it up at the right time, it makes sure a WhatsApp Web tab is open, and it
  drives each campaign's targets (looping lists → chats, applying delays,
  logging results) by real WhatsApp chat ID (`waId`, e.g. `1234567890@c.us`
  or `123-456@g.us`) — not by display-name text, so two chats that happen to
  share a name can never be confused with each other.
- Everything (messages incl. media, fetched chats, lists, campaigns, logs,
  settings, last-open tab) is stored locally via `chrome.storage.local`
  (with the `unlimitedStorage` permission, since saved images/documents can
  be a few MB) — nothing leaves your machine, there's no external server.

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
7. Click the extension icon: save a message, build a list from the Lists
   tab, accept the consent checkbox on the Campaigns tab, then create a
   campaign.

**Upgrading from an older version of this extension:** lists saved before
this version won't carry their members forward correctly. Rebuild any
existing lists once: **Scan**, search/select, and re-save each list
(one-time cleanup).

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
  never hit. The admin-only-group check and Community redirect *do* need
  real per-group metadata (unlike scanning) to do their job, so if metadata
  resolution crashes there (e.g. because some other group in the account
  has broken state, unrelated to the one actually being sent to) it's
  treated as "couldn't check" and the send proceeds anyway, rather than
  blocking every send in the account on an unrelated group's problem.
- **Edge specifically** can put an inactive background tab to sleep
  ("Sleeping tabs", enabled by default) after a period of idle time — since
  this extension deliberately keeps the WhatsApp tab in the background so
  it never steals focus, it's exactly the kind of tab that targets. Chrome
  doesn't do this by default, which is why the same extension can behave
  differently between the two browsers. If sends start failing partway
  through a campaign on Edge with "WhatsApp Web tab is not ready," this is
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
