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

- **Messages tab** — save a library of message drafts: plain text, or an
  image/document with an optional caption. Edit or delete any saved message;
  each one tracks when it was last sent.
- **Lists tab** — open web.whatsapp.com in a normal tab, click "Scan open
  chats" to pull *every* group and contact directly from WhatsApp's own chat
  list (exact group/contact tagging, not a guess), or add an individual
  contact by phone number. Search the fetched chats, use Select all/Deselect
  all to work through them quickly, and save your picks as a **named list**
  — e.g. "Family groups", "Work team", "Customers". There's no separate
  "pool" step: scan, pick, save. Build as many lists as you like, and
  editing one re-shows its saved members even without rescanning.
- **Campaigns tab** — pick a saved message, pick one or more saved lists,
  and choose either "every day at HH:MM" or "one time on [date/time]". Choose
  a sending mode:
  - **Paced** — applies the configured delay range between every send.
  - **Fast** — a short fixed gap only (~1–1.5s), for higher volume in less
    time (higher risk — see above).
  Set the delay range between messages, and (if a campaign targets multiple
  lists) the delay before starting the next list. Pause/resume, run
  immediately, or delete any campaign.
- **Log tab** — history of what was sent, when, to which chat, and whether
  it succeeded or failed.
- **Safety tab** — the consent checkbox, jitter (± minutes around a fixed
  scheduled time), default delay ranges, and a light/dark/system appearance
  toggle matching WhatsApp Web's own theme.

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
- Everything (messages incl. media, lists, chat pool, campaigns, logs,
  settings) is stored locally via `chrome.storage.local` (with the
  `unlimitedStorage` permission, since saved images/documents can be a few
  MB) — nothing leaves your machine, there's no external server.

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

**Upgrading from an older version of this extension:** the Lists tab no
longer keeps a separate "chat pool" — scanning feeds straight into the list
you're building/editing, and lists saved before this version won't carry
their members forward correctly. Rebuild any existing lists once: **Scan
open chats**, search/select, and re-save each list (one-time cleanup).

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
- A WhatsApp **Community** shows up as two entries with the same name when
  scanning — the community itself and its default announcement group are
  separate chats underneath. Scanning tags the community wrapper as
  "community" (not "group") specifically so this is visible instead of
  looking like a duplicate — pick whichever one (or both) you actually mean
  to message.
