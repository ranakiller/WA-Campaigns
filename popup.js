function call(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...payload }, (res) => resolve(res || { ok: false, error: 'No response' }));
  });
}

let STATE = { lists: [], messages: [], campaigns: [], log: [], settings: {} };
let pendingMedia = null; // { dataUrl, filename, mimeType }
let editingMessageId = null;
let editingListId = null;
let editingCampaignId = null;

// Session-only cache of chats seen via scan/manual-add this popup session —
// there's no persistent "pool"; scan, pick, and save straight into a list.
let chatSource = new Map(); // waId -> { waId, name, type }
let selectedWaIds = new Set();
let listSearchQuery = '';

async function refresh() {
  const res = await call('getState');
  if (res.ok) STATE = res.state;
  applyTheme();
  renderMessages();
  renderListBuilder();
  renderLists();
  renderCampaignForm();
  renderCampaignList();
  renderLog();
  renderSettings();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function secToMs(sec, fallback) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? n * 1000 : fallback;
}

// ---------- theme ----------
function applyTheme() {
  const theme = STATE.settings.theme || 'system';
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

document.getElementById('themeToggleBtn').addEventListener('click', async () => {
  const order = ['system', 'light', 'dark'];
  const current = STATE.settings.theme || 'system';
  const next = order[(order.indexOf(current) + 1) % order.length];
  await call('saveSettings', { settings: { theme: next } });
  refresh();
});

// ---------- tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ============ MESSAGES ============

document.querySelectorAll('.kind-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.kind-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const isMedia = btn.dataset.kind === 'media';
    document.getElementById('mediaPicker').style.display = isMedia ? '' : 'none';
    document.getElementById('msgTextLabel').textContent = isMedia ? 'Caption (optional)' : 'Message text';
  });
});

function currentKind() {
  return document.querySelector('.kind-btn.active').dataset.kind;
}
function setKind(kind) {
  document.querySelectorAll('.kind-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  document.getElementById('mediaPicker').style.display = kind === 'media' ? '' : 'none';
  document.getElementById('msgTextLabel').textContent = kind === 'media' ? 'Caption (optional)' : 'Message text';
}

document.getElementById('msgFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    alert('That file is larger than 15MB — WhatsApp Web may reject it.');
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingMedia = { dataUrl: reader.result, filename: file.name, mimeType: file.type };
    renderMediaPreview();
  };
  reader.readAsDataURL(file);
});

function renderMediaPreview() {
  const box = document.getElementById('mediaPreview');
  if (!pendingMedia) {
    box.innerHTML = '';
    return;
  }
  if (pendingMedia.mimeType && pendingMedia.mimeType.startsWith('image/')) {
    box.innerHTML = `<img src="${pendingMedia.dataUrl}" alt="" />`;
  } else {
    box.innerHTML = `<div class="file-chip">📄 ${escapeHtml(pendingMedia.filename)}</div>`;
  }
}

function resetMessageForm() {
  editingMessageId = null;
  pendingMedia = null;
  document.getElementById('msgLabel').value = '';
  document.getElementById('msgText').value = '';
  document.getElementById('msgFile').value = '';
  setKind('text');
  renderMediaPreview();
  document.getElementById('saveMessageBtn').textContent = 'Save message';
  document.getElementById('cancelEditMessageBtn').style.display = 'none';
}

document.getElementById('cancelEditMessageBtn').addEventListener('click', resetMessageForm);

document.getElementById('saveMessageBtn').addEventListener('click', async () => {
  const kind = currentKind();
  const text = document.getElementById('msgText').value.trim();
  const label = document.getElementById('msgLabel').value.trim();

  if (kind === 'text' && !text) {
    alert('Write a message first.');
    return;
  }
  if (kind === 'media' && !pendingMedia) {
    alert('Choose a file to attach.');
    return;
  }
  const name = label || (kind === 'media' ? pendingMedia.filename : text.slice(0, 30));
  const message = { id: editingMessageId, name, kind, text, media: kind === 'media' ? pendingMedia : null };
  await call('saveMessage', { message });
  resetMessageForm();
  refresh();
});

function renderMessages() {
  const ul = document.getElementById('messageList');
  ul.innerHTML = '';
  if (STATE.messages.length === 0) {
    ul.innerHTML = '<li class="item-text">No saved messages yet.</li>';
  }
  for (const m of STATE.messages) {
    const li = document.createElement('li');
    const preview =
      m.kind === 'media'
        ? `📎 ${escapeHtml(m.media ? m.media.filename : 'attachment')}${m.text ? ' — ' + escapeHtml(m.text.slice(0, 60)) : ''}`
        : escapeHtml(m.text.slice(0, 80));
    const lastSent = m.lastSentAt ? `Last sent ${new Date(m.lastSentAt).toLocaleString()}` : 'Never sent';
    li.innerHTML = `<div class="item-text">
        <b>${escapeHtml(m.name)}</b><br/>${preview}<br/>
        <span class="log-time">${lastSent}</span>
      </div>
      <div class="item-actions">
        <button class="small" data-act="edit">Edit</button>
        <button class="small danger" data-act="del">Delete</button>
      </div>`;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingMessageId = m.id;
      document.getElementById('msgLabel').value = m.name;
      document.getElementById('msgText').value = m.text || '';
      setKind(m.kind);
      pendingMedia = m.media || null;
      renderMediaPreview();
      document.getElementById('saveMessageBtn').textContent = 'Update message';
      document.getElementById('cancelEditMessageBtn').style.display = '';
      document.querySelector('[data-tab="messages"]').click();
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await call('deleteMessage', { id: m.id });
      refresh();
    });
    ul.appendChild(li);
  }
}

// ============ LISTS ============
// No persistent "pool" — scan/add feeds a session-only chatSource map, the
// user searches/selects straight out of that, and a list stores its member
// chats inline (waId/name/type) so it's self-contained once saved.

document.getElementById('scanChatsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanChatsBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  const res = await call('listOpenChats');
  btn.disabled = false;
  btn.textContent = 'Scan open chats';
  if (!res.ok) {
    alert(res.error || 'Could not scan chats.');
    return;
  }
  for (const c of res.chats || []) {
    if (c.waId) chatSource.set(c.waId, c);
  }
  if ((res.chats || []).length === 0) {
    alert('No chats found — is web.whatsapp.com open and logged in?');
  }
  renderListBuilder();
});

document.getElementById('manualAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('manualContactNumber');
  const number = input.value.trim();
  if (!number) return;
  const btn = document.getElementById('manualAddBtn');
  btn.disabled = true;
  const res = await call('findContactByNumber', { number });
  btn.disabled = false;
  if (!res.ok) {
    alert(res.error || 'Could not find that contact.');
    return;
  }
  chatSource.set(res.contact.waId, res.contact);
  selectedWaIds.add(res.contact.waId); // explicitly added, so pre-select it
  input.value = '';
  renderListBuilder();
});

document.getElementById('listSearchInput').addEventListener('input', (e) => {
  listSearchQuery = e.target.value.trim().toLowerCase();
  renderListBuilder();
});

function filteredChatSource() {
  const all = Array.from(chatSource.values());
  const filtered = listSearchQuery ? all.filter((c) => c.name.toLowerCase().includes(listSearchQuery)) : all;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

document.getElementById('selectAllBtn').addEventListener('click', () => {
  for (const c of filteredChatSource()) selectedWaIds.add(c.waId);
  renderListBuilder();
});
document.getElementById('deselectAllBtn').addEventListener('click', () => {
  for (const c of filteredChatSource()) selectedWaIds.delete(c.waId);
  renderListBuilder();
});

function renderListBuilder() {
  const box = document.getElementById('listBuilderChecklist');
  const visible = filteredChatSource();
  box.innerHTML =
    visible
      .map(
        (c) =>
          `<label><input type="checkbox" class="list-builder-check" value="${escapeHtml(c.waId)}" ${selectedWaIds.has(c.waId) ? 'checked' : ''}/> ${escapeHtml(c.name)} <span class="badge badge-${c.type}">${c.type}</span></label>`
      )
      .join('') || '<span class="hint">Scan or add a contact above first.</span>';
  box.querySelectorAll('.list-builder-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedWaIds.add(cb.value);
      else selectedWaIds.delete(cb.value);
      document.getElementById('selectedCount').textContent = `${selectedWaIds.size} selected`;
    });
  });
  document.getElementById('selectedCount').textContent = `${selectedWaIds.size} selected`;
}

function resetListForm() {
  editingListId = null;
  selectedWaIds = new Set();
  listSearchQuery = '';
  document.getElementById('listName').value = '';
  document.getElementById('listSearchInput').value = '';
  document.getElementById('listBuilderTitle').textContent = 'Build a list';
  document.getElementById('saveListBtn').textContent = 'Save list';
  document.getElementById('cancelEditListBtn').style.display = 'none';
  renderListBuilder();
}
document.getElementById('cancelEditListBtn').addEventListener('click', resetListForm);

document.getElementById('saveListBtn').addEventListener('click', async () => {
  const name = document.getElementById('listName').value.trim();
  if (!name) {
    alert('Give this list a name.');
    return;
  }
  if (selectedWaIds.size === 0) {
    alert('Select at least one group/contact.');
    return;
  }
  const members = Array.from(selectedWaIds).map((waId) => chatSource.get(waId)).filter(Boolean);
  await call('saveList', { list: { id: editingListId, name, members } });
  resetListForm();
  refresh();
});

function renderLists() {
  const ul = document.getElementById('listsList');
  ul.innerHTML = '';
  if (STATE.lists.length === 0) {
    ul.innerHTML = '<li class="item-text">No saved lists yet.</li>';
  }
  for (const l of STATE.lists) {
    const members = l.members || [];
    const names = members.map((m) => m.name);
    const li = document.createElement('li');
    li.innerHTML = `<div class="item-text">
        <b>${escapeHtml(l.name)}</b> <span class="muted">(${members.length})</span><br/>
        <span class="log-time">${escapeHtml(names.slice(0, 4).join(', '))}${names.length > 4 ? '…' : ''}</span>
      </div>
      <div class="item-actions">
        <button class="small" data-act="edit">Edit</button>
        <button class="small danger" data-act="del">Delete</button>
      </div>`;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingListId = l.id;
      selectedWaIds = new Set(members.map((m) => m.waId));
      for (const m of members) chatSource.set(m.waId, m); // merge so they show without a fresh scan
      listSearchQuery = '';
      document.getElementById('listSearchInput').value = '';
      document.getElementById('listName').value = l.name;
      document.getElementById('listBuilderTitle').textContent = `Editing "${l.name}"`;
      document.getElementById('saveListBtn').textContent = 'Update list';
      document.getElementById('cancelEditListBtn').style.display = '';
      renderListBuilder();
      document.querySelector('[data-tab="lists"]').click();
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete list "${l.name}"? Campaigns using it will have it removed from their targets.`)) return;
      await call('deleteList', { id: l.id });
      refresh();
    });
    ul.appendChild(li);
  }
}

// ============ CAMPAIGNS ============

document.getElementById('consentAcceptBtn').addEventListener('click', async () => {
  if (!document.getElementById('consentCheckbox').checked) {
    alert('Please check the box to confirm before enabling campaigns.');
    return;
  }
  await call('saveSettings', { settings: { consentAccepted: true } });
  refresh();
});

document.getElementById('campScheduleType').addEventListener('change', (e) => {
  const isFixed = e.target.value === 'fixed';
  document.getElementById('campTimeFixed').style.display = isFixed ? '' : 'none';
  document.getElementById('campTimeOnce').style.display = isFixed ? 'none' : '';
});

function resetCampaignForm() {
  editingCampaignId = null;
  document.getElementById('campName').value = '';
  document.getElementById('campScheduleType').value = 'fixed';
  document.getElementById('campTimeFixed').value = '09:00';
  document.getElementById('campTimeFixed').style.display = '';
  document.getElementById('campTimeOnce').value = '';
  document.getElementById('campTimeOnce').style.display = 'none';
  document.querySelector('input[name="sendMode"][value="paced"]').checked = true;
  const s = STATE.settings;
  const [dMin, dMax] = s.defaultDelayBetweenMsMs || [20000, 45000];
  const [lMin, lMax] = s.defaultDelayBetweenListsMs || [30000, 60000];
  document.getElementById('campDelayMin').value = Math.round(dMin / 1000);
  document.getElementById('campDelayMax').value = Math.round(dMax / 1000);
  document.getElementById('campListDelayMin').value = Math.round(lMin / 1000);
  document.getElementById('campListDelayMax').value = Math.round(lMax / 1000);
  document.getElementById('addCampaignBtn').textContent = 'Save campaign';
  document.getElementById('cancelEditCampaignBtn').style.display = 'none';
  renderCampaignForm();
}
document.getElementById('cancelEditCampaignBtn').addEventListener('click', resetCampaignForm);

function renderCampaignForm() {
  const sel = document.getElementById('campMessageSelect');
  sel.innerHTML =
    STATE.messages.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('') ||
    '<option value="">No messages saved</option>';

  const checklist = document.getElementById('campListChecklist');
  const checkedIds = editingCampaignId
    ? new Set((STATE.campaigns.find((c) => c.id === editingCampaignId) || { listIds: [] }).listIds)
    : new Set(Array.from(document.querySelectorAll('.camp-list-check:checked')).map((cb) => cb.value));
  checklist.innerHTML =
    STATE.lists
      .map(
        (l) =>
          `<label><input type="checkbox" class="camp-list-check" value="${l.id}" ${checkedIds.has(l.id) ? 'checked' : ''}/> ${escapeHtml(l.name)} <span class="muted">(${(l.members || []).length})</span></label>`
      )
      .join('') || '<span class="hint">Build a list first.</span>';

  const gate = document.getElementById('consentGate');
  const content = document.getElementById('campaignsContent');
  const accepted = !!STATE.settings.consentAccepted;
  gate.style.display = accepted ? 'none' : '';
  content.style.display = accepted ? '' : 'none';
}

document.getElementById('addCampaignBtn').addEventListener('click', async () => {
  const name = document.getElementById('campName').value.trim();
  const messageId = document.getElementById('campMessageSelect').value;
  const listIds = Array.from(document.querySelectorAll('.camp-list-check:checked')).map((cb) => cb.value);
  const scheduleType = document.getElementById('campScheduleType').value;
  const sendMode = document.querySelector('input[name="sendMode"]:checked').value;

  if (!name) { alert('Give this campaign a name.'); return; }
  if (!messageId) { alert('Pick a saved message.'); return; }
  if (listIds.length === 0) { alert('Pick at least one list.'); return; }

  const campaign = {
    id: editingCampaignId,
    name,
    messageId,
    listIds,
    scheduleType,
    sendMode,
    enabled: true,
    delayBetweenMsMs: [
      secToMs(document.getElementById('campDelayMin').value, 20000),
      secToMs(document.getElementById('campDelayMax').value, 45000)
    ],
    delayBetweenListsMs: [
      secToMs(document.getElementById('campListDelayMin').value, 30000),
      secToMs(document.getElementById('campListDelayMax').value, 60000)
    ]
  };
  if (scheduleType === 'fixed') {
    campaign.time = document.getElementById('campTimeFixed').value || '09:00';
  } else {
    const dt = document.getElementById('campTimeOnce').value;
    if (!dt) { alert('Pick a date/time.'); return; }
    campaign.datetime = dt;
  }
  await call('saveCampaign', { campaign });
  resetCampaignForm();
  refresh();
});

function renderCampaignList() {
  const ul = document.getElementById('campaignList');
  ul.innerHTML = '';
  if (STATE.campaigns.length === 0) {
    ul.innerHTML = '<li class="item-text">No campaigns yet.</li>';
  }
  for (const c of STATE.campaigns) {
    const msg = STATE.messages.find((m) => m.id === c.messageId);
    const listNames = STATE.lists.filter((l) => c.listIds.includes(l.id)).map((l) => l.name);
    const whenText = c.scheduleType === 'fixed' ? `every day at ${c.time}` : `once at ${new Date(c.datetime).toLocaleString()}`;
    const li = document.createElement('li');
    li.innerHTML = `<div class="item-text">
        <b>${escapeHtml(c.name)}</b><br/>
        ${msg ? escapeHtml(msg.name) : '(deleted message)'} → ${escapeHtml(listNames.join(', ') || '(no lists)')}<br/>
        <span class="log-time">${whenText} · ${c.sendMode} · ${c.enabled ? 'enabled' : 'paused'}</span>
      </div>
      <div class="item-actions">
        <button class="small" data-act="edit">Edit</button>
        <button class="small" data-act="toggle">${c.enabled ? 'Pause' : 'Resume'}</button>
        <button class="small" data-act="run">Run now</button>
        <button class="small danger" data-act="del">Delete</button>
      </div>`;
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      editingCampaignId = c.id;
      document.getElementById('campName').value = c.name;
      document.getElementById('campScheduleType').value = c.scheduleType;
      document.getElementById('campScheduleType').dispatchEvent(new Event('change'));
      if (c.scheduleType === 'fixed') document.getElementById('campTimeFixed').value = c.time;
      else document.getElementById('campTimeOnce').value = c.datetime;
      document.querySelector(`input[name="sendMode"][value="${c.sendMode}"]`).checked = true;
      const [dMin, dMax] = c.delayBetweenMsMs || [20000, 45000];
      const [lMin, lMax] = c.delayBetweenListsMs || [30000, 60000];
      document.getElementById('campDelayMin').value = Math.round(dMin / 1000);
      document.getElementById('campDelayMax').value = Math.round(dMax / 1000);
      document.getElementById('campListDelayMin').value = Math.round(lMin / 1000);
      document.getElementById('campListDelayMax').value = Math.round(lMax / 1000);
      document.getElementById('addCampaignBtn').textContent = 'Update campaign';
      document.getElementById('cancelEditCampaignBtn').style.display = '';
      renderCampaignForm();
      document.querySelector('[data-tab="campaigns"]').click();
    });
    li.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      await call('toggleCampaign', { id: c.id, enabled: !c.enabled });
      refresh();
    });
    li.querySelector('[data-act="run"]').addEventListener('click', async () => {
      await call('runCampaignNow', { id: c.id });
      setTimeout(refresh, 1500);
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete campaign "${c.name}"?`)) return;
      await call('deleteCampaign', { id: c.id });
      refresh();
    });
    ul.appendChild(li);
  }
}

// ============ LOG ============
function renderLog() {
  const ul = document.getElementById('logList');
  ul.innerHTML = '';
  if (STATE.log.length === 0) {
    ul.innerHTML = '<li class="item-text">No activity yet.</li>';
  }
  for (const l of STATE.log) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="item-text">
      <span class="log-status-${l.status}">${l.status.toUpperCase()}</span>
      ${l.campaignName ? ' · ' + escapeHtml(l.campaignName) : ''}
      ${l.chatName ? ' → ' + escapeHtml(l.chatName) : ''}<br/>
      <span class="log-time">${new Date(l.timestamp).toLocaleString()}</span><br/>
      ${escapeHtml(l.detail || '')}
    </div>`;
    ul.appendChild(li);
  }
}

// ============ SETTINGS ============
function renderSettings() {
  const s = STATE.settings;
  document.getElementById('jitterMinutes').value = s.jitterMinutes ?? 4;
  const [min, max] = s.defaultDelayBetweenMsMs || [20000, 45000];
  document.getElementById('delayMin').value = Math.round(min / 1000);
  document.getElementById('delayMax').value = Math.round(max / 1000);
  const [lmin, lmax] = s.defaultDelayBetweenListsMs || [30000, 60000];
  document.getElementById('listDelayMin').value = Math.round(lmin / 1000);
  document.getElementById('listDelayMax').value = Math.round(lmax / 1000);
  document.getElementById('themeSelect').value = s.theme || 'system';
  document.getElementById('consentCheckboxSettings').checked = !!s.consentAccepted;
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const jitterMinutes = Number(document.getElementById('jitterMinutes').value) || 0;
  const min = secToMs(document.getElementById('delayMin').value, 20000);
  const max = secToMs(document.getElementById('delayMax').value, 45000);
  const lmin = secToMs(document.getElementById('listDelayMin').value, 30000);
  const lmax = secToMs(document.getElementById('listDelayMax').value, 60000);
  const theme = document.getElementById('themeSelect').value;
  const consentAccepted = document.getElementById('consentCheckboxSettings').checked;
  await call('saveSettings', {
    settings: {
      jitterMinutes,
      defaultDelayBetweenMsMs: [min, Math.max(min, max)],
      defaultDelayBetweenListsMs: [lmin, Math.max(lmin, lmax)],
      theme,
      consentAccepted
    }
  });
  refresh();
});

refresh();
