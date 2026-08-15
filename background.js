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

async function getState() {
  const data = await chrome.storage.local.get([
    'lists',
    'messages',
    'campaigns',
    'log',
    'settings'
  ]);
  return {
    lists: data.lists || [],
    messages: data.messages || [],
    campaigns: data.campaigns || [],
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

// 'paced' uses the campaign's configured delay range between sends (the
// safety-oriented default); 'fast' uses a short fixed gap, just enough to
// avoid firing sends literally back-to-back. Sends themselves are always
// awaited via WPP's own send functions — there's no separate "confirmation"
// step anymore, the promise resolving *is* the confirmation.
const FAST_MODE_DELAY_MS = [800, 1500];

async function sendOneMessage(waId, message) {
  const tab = await ensureWaTab();
  const ready = await pingContentScript(tab.id);
  if (!ready) {
    throw new Error(
      'WhatsApp Web tab is not ready (make sure you are logged in / QR code is scanned, and the page finished loading).'
    );
  }
  let res;
  if (message.kind === 'media' && message.media) {
    res = await sendToTab(tab.id, { action: 'sendMedia', waId, media: message.media, caption: message.text || '' }, 45000);
  } else {
    res = await sendToTab(tab.id, { action: 'sendMessage', waId, text: message.text }, 30000);
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

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        await sendOneMessage(target.waId, message);
        totalSent++;
        await appendLog({
          campaignId: campaign.id,
          campaignName: campaign.name,
          chatName: target.name,
          status: 'success',
          detail: `Sent: "${(message.text || '[media]').slice(0, 60)}"`
        });
      } catch (err) {
        totalFailed++;
        await appendLog({
          campaignId: campaign.id,
          campaignName: campaign.name,
          chatName: target.name,
          status: 'error',
          detail: String(err.message || err)
        });
      }
      if (i < targets.length - 1) {
        const delayRange = campaign.sendMode === 'fast' ? FAST_MODE_DELAY_MS : campaign.delayBetweenMsMs || settings.defaultDelayBetweenMsMs;
        await new Promise((r) => setTimeout(r, randomBetween(delayRange)));
      }
    }

    if (li < targetLists.length - 1) {
      const delayRange = campaign.delayBetweenListsMs || settings.defaultDelayBetweenListsMs;
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

function alarmIdForFixed(campaignId) {
  return `fixed:${campaignId}`;
}
function alarmIdForOnce(campaignId) {
  return `once:${campaignId}`;
}

function nextFixedTimeMs(hhmm, jitterMinutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const jitterMs = (Math.random() * 2 - 1) * jitterMinutes * 60000;
  return target.getTime() + jitterMs;
}

async function scheduleCampaignAlarm(campaign) {
  const { settings } = await getState();
  if (!campaign.enabled) return;

  if (campaign.scheduleType === 'fixed') {
    const when = nextFixedTimeMs(campaign.time, settings.jitterMinutes);
    chrome.alarms.create(alarmIdForFixed(campaign.id), { when });
  } else if (campaign.scheduleType === 'once') {
    const when = new Date(campaign.datetime).getTime();
    if (when > Date.now()) {
      chrome.alarms.create(alarmIdForOnce(campaign.id), { when });
    }
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
  const [kind, campaignId] = alarm.name.split(':');
  const campaign = campaigns.find((c) => c.id === campaignId);
  if (!campaign) return;

  await runCampaign(campaign);

  if (kind === 'fixed') {
    // Reschedule tomorrow (fresh jitter each day).
    await scheduleCampaignAlarm(campaign);
  } else if (kind === 'once') {
    const { campaigns: current } = await getState();
    const updated = current.map((c) => (c.id === campaign.id ? { ...c, enabled: false, lastRun: Date.now() } : c));
    await setState({ campaigns: updated });
  }
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

        // ---- fetching chats (no persistent pool — the popup holds these
        // in memory for the session and saves the picked ones straight into
        // a list's `members`) ----
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
          const res = await sendToTab(tab.id, { action: 'listChats' }, 20000);
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
          await chrome.alarms.clear(alarmIdForFixed(msg.id));
          await chrome.alarms.clear(alarmIdForOnce(msg.id));
          await setState({ campaigns: campaigns.filter((c) => c.id !== msg.id) });
          sendResponse({ ok: true });
          break;
        }
        case 'toggleCampaign': {
          const { campaigns } = await getState();
          const next = campaigns.map((c) => (c.id === msg.id ? { ...c, enabled: msg.enabled } : c));
          await setState({ campaigns: next });
          if (msg.enabled) {
            const campaign = next.find((c) => c.id === msg.id);
            await scheduleCampaignAlarm(campaign);
          } else {
            await chrome.alarms.clear(alarmIdForFixed(msg.id));
            await chrome.alarms.clear(alarmIdForOnce(msg.id));
          }
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
