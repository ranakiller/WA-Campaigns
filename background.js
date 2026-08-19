// background.js — service worker: owns storage, scheduling (chrome.alarms),
// and talks to the content script running inside the WhatsApp Web tab.

const WA_URL_PATTERN = 'https://web.whatsapp.com/*';
const DEFAULT_SETTINGS = {
  jitterMinutes: 4, // fixed-time campaigns fire within +/- this many minutes
  defaultDelayBetweenMsMs: [20000, 45000], // human-ish gap between consecutive sends
  defaultDelayBetweenListsMs: [30000, 60000], // gap before starting the next list in a campaign
  consentAccepted: false,
  theme: 'system' // 'system' | 'light' | 'dark'
};

// ---------- storage helpers ----------

// A saved message used to be a single {kind, text, media} — now it's a named
// sequence of items (each independently text, or media with its own
// caption), sent one after another to a chat before moving to the next.
// Older stored messages are normalized to the new shape on read so nothing
// needs a one-time migration step.
function migrateMessage(m) {
  if (Array.isArray(m.items)) return m;
  const item =
    m.kind === 'media' && m.media
      ? { kind: 'media', media: m.media, caption: m.text || '' }
      : { kind: 'text', text: m.text || '' };
  return { ...m, items: [item] };
}

// Campaigns used to have one schedule slot (a single daily time, or a
// single one-off datetime) and a Paced/Fast sendMode. Now a campaign can
// have multiple daily times, a repeating interval, or multiple one-off
// datetimes, and delay is either "use the Safety-tab defaults" or fully
// custom — older stored campaigns are normalized to the new shape on read.
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
  return next;
}

async function getState() {
  const data = await chrome.storage.local.get([
    'fetchedChats',
    'lists',
    'messages',
    'campaigns',
    'log',
    'settings'
  ]);
  return {
    fetchedChats: data.fetchedChats || [],
    lists: data.lists || [],
    messages: (data.messages || []).map(migrateMessage),
    campaigns: (data.campaigns || []).map(migrateCampaign),
    log: data.log || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) }
  };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
}

async function appendLog(entry) {
  const { log } = await getState();
  const next = [{ id: crypto.randomUUID(), timestamp: Date.now(), ...entry }, ...log].slice(
    0,
    300
  );
  await setState({ log: next });
}

function uid() {
  return crypto.randomUUID();
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

// ---------- sending ----------

function randomBetween([min, max]) {
  return min + Math.random() * (max - min);
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
  const message = messages.find((m) => m.id === campaign.messageId);
  if (!message) {
    await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'Message no longer exists.' });
    return;
  }
  const items = message.items || [];
  if (items.length === 0) {
    await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'Message has no content.' });
    return;
  }
  const targetLists = lists.filter((l) => campaign.listIds.includes(l.id));
  if (targetLists.length === 0) {
    await appendLog({ campaignId: campaign.id, campaignName: campaign.name, status: 'error', detail: 'No valid lists.' });
    return;
  }

  let totalSent = 0;
  let totalFailed = 0;

  for (let li = 0; li < targetLists.length; li++) {
    const list = targetLists[li];
    const targets = list.members || [];

    // Flatten (chat × item) into one queue so pacing is uniform whether
    // consecutive sends are to different chats or multiple items landing
    // in the same chat — e.g. 10 images to one group get the same
    // between-send delay as sends to 10 different chats would.
    const queue = [];
    for (const target of targets) {
      items.forEach((item, itemIndex) => queue.push({ target, item, itemIndex }));
    }

    for (let i = 0; i < queue.length; i++) {
      const { target, item, itemIndex } = queue[i];
      const itemLabel = items.length > 1 ? ` (item ${itemIndex + 1}/${items.length})` : '';
      let sent = false;
      try {
        await sendOneItem(target.waId, item);
        sent = true;
        totalSent++;
        await appendLog({
          campaignId: campaign.id,
          campaignName: campaign.name,
          chatName: target.name,
          status: 'success',
          detail: `Sent${itemLabel}: "${(item.text || item.caption || '[media]').slice(0, 60)}"`
        });
      } catch (err) {
        totalFailed++;
        await appendLog({
          campaignId: campaign.id,
          campaignName: campaign.name,
          chatName: target.name,
          status: 'error',
          detail: `${String(err.message || err)}${itemLabel}`
        });
      }
      // Only pace after a real send — a skipped/failed attempt didn't put
      // anything on the wire, so there's nothing to space out.
      if (sent && i < queue.length - 1) {
        const delayRange = campaign.useDefaultDelay ? settings.defaultDelayBetweenMsMs : campaign.delayBetweenMsMs || settings.defaultDelayBetweenMsMs;
        await new Promise((r) => setTimeout(r, randomBetween(delayRange)));
      }
    }

    if (li < targetLists.length - 1) {
      const delayRange = campaign.useDefaultDelay ? settings.defaultDelayBetweenListsMs : campaign.delayBetweenListsMs || settings.defaultDelayBetweenListsMs;
      await new Promise((r) => setTimeout(r, randomBetween(delayRange)));
    }
  }

  await setState({
    messages: messages.map((m) => (m.id === message.id ? { ...m, lastSentAt: Date.now() } : m))
  });

  chrome.notifications.create(uid(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'WhatsApp Scheduler',
    message: `Campaign "${campaign.name}" finished: ${totalSent} sent, ${totalFailed} failed.`
  });
}

// ---------- alarm scheduling ----------
// A campaign's schedule is one of:
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

function alarmIdForTime(campaignId, idx) {
  return `times:${campaignId}:${idx}`;
}
function alarmIdForInterval(campaignId) {
  return `interval:${campaignId}`;
}
function alarmIdForOnce(campaignId, idx) {
  return `once:${campaignId}:${idx}`;
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

// Does "now" fall inside the campaign's active-hours window? A window
// wrapping past midnight (e.g. 22:00–06:00) is handled too. No window
// configured means "always active".
function isWithinActiveWindow(campaign) {
  if (!campaign.windowStart || !campaign.windowEnd) return true;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = campaign.windowStart.split(':').map(Number);
  const [eh, em] = campaign.windowEnd.split(':').map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  if (startMinutes <= endMinutes) return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

async function clearCampaignAlarms(campaignId) {
  const all = await chrome.alarms.getAll();
  await Promise.all(
    all.filter((a) => a.name.split(':')[1] === campaignId).map((a) => chrome.alarms.clear(a.name))
  );
}

async function scheduleCampaignAlarm(campaign) {
  const { settings } = await getState();
  await clearCampaignAlarms(campaign.id);
  if (!campaign.enabled) return;

  if (campaign.scheduleType === 'times') {
    (campaign.times || []).forEach((time, idx) => {
      const when = nextDailyTimeMs(time, settings.jitterMinutes);
      chrome.alarms.create(alarmIdForTime(campaign.id, idx), { when });
    });
  } else if (campaign.scheduleType === 'interval') {
    const periodInMinutes = Math.max(1, Math.round(campaign.intervalMinutes) || 60);
    chrome.alarms.create(alarmIdForInterval(campaign.id), { delayInMinutes: periodInMinutes, periodInMinutes });
  } else if (campaign.scheduleType === 'once') {
    (campaign.datetimes || []).forEach((dt, idx) => {
      if (!dt) return; // tombstoned (already fired)
      const when = new Date(dt).getTime();
      if (when > Date.now()) {
        chrome.alarms.create(alarmIdForOnce(campaign.id, idx), { when });
      }
    });
  }
}

async function rebuildAllAlarms() {
  await chrome.alarms.clearAll();
  const { campaigns } = await getState();
  for (const campaign of campaigns) {
    if (campaign.enabled) await scheduleCampaignAlarm(campaign);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const { campaigns } = await getState();
  const [kind, campaignId, idxStr] = alarm.name.split(':');
  const campaign = campaigns.find((c) => c.id === campaignId);
  if (!campaign) return;

  if (kind === 'interval' && !isWithinActiveWindow(campaign)) {
    return; // outside the configured hours — the alarm just fires again next period
  }

  await runCampaign(campaign);

  if (kind === 'times') {
    const idx = Number(idxStr);
    const time = (campaign.times || [])[idx];
    if (time) {
      const { settings } = await getState();
      chrome.alarms.create(alarmIdForTime(campaign.id, idx), { when: nextDailyTimeMs(time, settings.jitterMinutes) });
    }
  } else if (kind === 'once') {
    const idx = Number(idxStr);
    const { campaigns: current } = await getState();
    const updated = current.map((c) => {
      if (c.id !== campaign.id) return c;
      const datetimes = (c.datetimes || []).slice();
      datetimes[idx] = null; // tombstone — keeps other pending entries' indices stable
      const stillPending = datetimes.some(Boolean);
      return { ...c, datetimes, enabled: stillPending, lastRun: Date.now() };
    });
    await setState({ campaigns: updated });
  }
  // 'interval' alarms repeat on their own via periodInMinutes — nothing to reschedule.
});

chrome.runtime.onInstalled.addListener(() => rebuildAllAlarms());
chrome.runtime.onStartup.addListener(() => rebuildAllAlarms());

// ---------- messages from popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'getState': {
          sendResponse({ ok: true, state: await getState() });
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
          const { lists, campaigns } = await getState();
          sendResponse({
            ok: true,
            usedByCampaigns: campaigns.filter((c) => c.listIds.includes(msg.id)).map((c) => c.name)
          });
          await setState({
            lists: lists.filter((l) => l.id !== msg.id),
            campaigns: campaigns.map((c) => ({ ...c, listIds: c.listIds.filter((id) => id !== msg.id) }))
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
          const { messages, campaigns } = await getState();
          await setState({
            messages: messages.filter((m) => m.id !== msg.id),
            campaigns: campaigns.filter((c) => c.messageId !== msg.id)
          });
          sendResponse({ ok: true });
          break;
        }

        // ---- campaigns ----
        case 'saveCampaign': {
          const { campaigns } = await getState();
          const existingIdx = campaigns.findIndex((c) => c.id === msg.campaign.id);
          let next;
          const campaign = { ...msg.campaign, id: msg.campaign.id || uid() };
          if (existingIdx >= 0) {
            next = campaigns.slice();
            next[existingIdx] = campaign;
          } else {
            next = [...campaigns, campaign];
          }
          await setState({ campaigns: next });
          await scheduleCampaignAlarm(campaign);
          sendResponse({ ok: true });
          break;
        }
        case 'deleteCampaign': {
          const { campaigns } = await getState();
          await clearCampaignAlarms(msg.id);
          await setState({ campaigns: campaigns.filter((c) => c.id !== msg.id) });
          sendResponse({ ok: true });
          break;
        }
        case 'toggleCampaign': {
          const { campaigns } = await getState();
          const next = campaigns.map((c) => (c.id === msg.id ? { ...c, enabled: msg.enabled } : c));
          await setState({ campaigns: next });
          // scheduleCampaignAlarm always clears existing alarms first, then
          // reschedules only if enabled — covers both toggle directions.
          await scheduleCampaignAlarm(next.find((c) => c.id === msg.id));
          sendResponse({ ok: true });
          break;
        }
        case 'runCampaignNow': {
          const { campaigns } = await getState();
          const campaign = campaigns.find((c) => c.id === msg.id);
          if (!campaign) {
            sendResponse({ ok: false, error: 'Campaign not found.' });
            break;
          }
          runCampaign(campaign); // fire and forget; log will update
          sendResponse({ ok: true });
          break;
        }

        // One-off send from the Messages tab — reuses runCampaign with a
        // transient, unpersisted campaign object so it gets the same
        // delay/logging/notification behavior without being saved/scheduled.
        case 'sendNow': {
          const { messages, settings } = await getState();
          const message = messages.find((m) => m.id === msg.messageId);
          if (!message) {
            sendResponse({ ok: false, error: 'Message not found.' });
            break;
          }
          if (!msg.listIds || msg.listIds.length === 0) {
            sendResponse({ ok: false, error: 'Pick at least one list.' });
            break;
          }
          runCampaign({
            id: `adhoc-${uid()}`,
            name: `Manual send: ${message.name}`,
            messageId: message.id,
            listIds: msg.listIds,
            useDefaultDelay: true,
            delayBetweenMsMs: settings.defaultDelayBetweenMsMs,
            delayBetweenListsMs: settings.defaultDelayBetweenListsMs
          });
          sendResponse({ ok: true });
          break;
        }

        case 'clearLog': {
          await setState({ log: [] });
          sendResponse({ ok: true });
          break;
        }

        case 'saveSettings': {
          const { settings } = await getState();
          await setState({ settings: { ...settings, ...msg.settings } });
          sendResponse({ ok: true });
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
