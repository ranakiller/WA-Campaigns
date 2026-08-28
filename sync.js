// Real-time Firebase sync — runs entirely inside background.js (the service
// worker). This file only ever transports whatever's already in
// chrome.storage.local; it doesn't change what any of the existing send/UI
// code expects to find there. popup.js never imports this directly — it
// just reads STATE.settings.syncEnabled and STATE.authUser like any other
// piece of state, and the on/off toggle round-trips through background.js
// like every other setting.
//
// Sync model: whole-value last-write-wins per key, compared by a plain
// millisecond timestamp (not Firestore's serverTimestamp — that resolves
// asynchronously server-side, which would make "is my local copy already
// current" hard to check right after writing). That's an intentional
// simplification for a personal, mostly-one-device-at-a-time tool: if the
// exact same key is edited on two devices within the same sync round-trip,
// whichever push lands later wins outright rather than merging item-by-item.
// `log` is the one entry point that most often changes fast (once per send),
// but sends are paced tens of seconds apart, so the write volume this
// produces is nowhere near Firestore's free-tier quota.
//
// Media (images/PDFs/docs) is the one thing that isn't stored inline in
// Firestore — a message's items keep their normal
// { dataUrl, filename, mimeType } shape locally, but the synced copy has
// { storagePath, filename, mimeType } instead, with the actual bytes in
// Firebase Storage (content-addressed by a hash of the data URL, so the
// same attachment reused across messages/devices only ever uploads once).
import { getFirebaseApp } from './firebase-init.js';
import { currentUser } from './auth.js';
import {
  initializeFirestore,
  memoryLocalCache,
  doc,
  getDoc,
  setDoc,
  onSnapshot
} from './vendor/firebase/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadString, getBytes } from './vendor/firebase/firebase-storage.js';

export const SYNC_KEYS = ['messages', 'lists', 'campaigns', 'settings', 'log'];

let dbInstance = null;
function getDb() {
  if (!dbInstance) dbInstance = initializeFirestore(getFirebaseApp(), { localCache: memoryLocalCache() });
  return dbInstance;
}

let storageInstance = null;
function getStorageInstance() {
  if (!storageInstance) storageInstance = getStorage(getFirebaseApp());
  return storageInstance;
}

function syncDocRef(uid, key) {
  return doc(getDb(), 'users', uid, 'sync', key);
}

// --- local bookkeeping: the updatedAt of whatever's currently reflected in
// chrome.storage.local for each synced key, so a remote read can tell
// "newer than what I have" from "this is just my own write echoing back". ---
async function getSyncMeta() {
  const data = await chrome.storage.local.get(['syncMeta']);
  return data.syncMeta || {};
}
async function setSyncMetaEntry(key, updatedAt) {
  const meta = await getSyncMeta();
  meta[key] = updatedAt;
  await chrome.storage.local.set({ syncMeta: meta });
}

// --- media transport (messages only) ---
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Uploads are content-addressed, so re-pushing an unchanged attachment (e.g.
// editing a message's caption without touching its image) is a cheap no-op
// past the first time this service worker instance has seen that hash.
const uploadedMediaHashes = new Set();

async function uploadMediaItem(item, uid) {
  const hash = await sha256Hex(item.media.dataUrl);
  const path = `users/${uid}/media/${hash}`;
  if (!uploadedMediaHashes.has(hash)) {
    await uploadString(storageRef(getStorageInstance(), path), item.media.dataUrl, 'data_url');
    uploadedMediaHashes.add(hash);
  }
  return { ...item, media: { filename: item.media.filename, mimeType: item.media.mimeType, storagePath: path } };
}

async function downloadMediaItem(item) {
  const bytes = await getBytes(storageRef(getStorageInstance(), item.media.storagePath));
  const dataUrl = `data:${item.media.mimeType};base64,${arrayBufferToBase64(bytes)}`;
  return { ...item, media: { filename: item.media.filename, mimeType: item.media.mimeType, dataUrl } };
}

async function toCloudShape(key, value, uid) {
  if (key !== 'messages') return value;
  const messages = [];
  for (const m of value) {
    const items = [];
    for (const item of m.items || []) {
      items.push(item.kind === 'media' && item.media && item.media.dataUrl ? await uploadMediaItem(item, uid) : item);
    }
    messages.push({ ...m, items });
  }
  return messages;
}

async function fromCloudShape(key, value) {
  if (key !== 'messages') return value;
  const messages = [];
  for (const m of value) {
    const items = [];
    for (const item of m.items || []) {
      items.push(item.kind === 'media' && item.media && item.media.storagePath ? await downloadMediaItem(item) : item);
    }
    messages.push({ ...m, items });
  }
  return messages;
}

// --- push: local change -> Firestore ---
export async function syncPush(key, value) {
  const user = currentUser();
  if (!user) return;
  const settings = (await chrome.storage.local.get(['settings'])).settings || {};
  if (!settings.syncEnabled) return;
  const updatedAt = Date.now();
  const cloudValue = await toCloudShape(key, value, user.uid);
  await setDoc(syncDocRef(user.uid, key), { value: cloudValue, updatedAt });
  await setSyncMetaEntry(key, updatedAt);
}

// --- apply a remote value straight into local storage, bypassing the
// generic setState() sync hook (see background.js) so pulling a change
// doesn't immediately re-push the exact same thing right back. ---
async function applyRemoteToLocal(key, value, updatedAt) {
  await chrome.storage.local.set({ [key]: value });
  await setSyncMetaEntry(key, updatedAt);
}

// --- one-shot catch-up for a single key: whichever side is newer wins,
// including "remote doesn't exist yet" (first sign-in seeds it from
// whatever's already stored locally on this device). ---
async function reconcileKey(key) {
  const user = currentUser();
  if (!user) return;
  const snap = await getDoc(syncDocRef(user.uid, key));
  const meta = await getSyncMeta();
  const localUpdatedAt = meta[key] || 0;
  const remote = snap.exists() ? snap.data() : null;
  const remoteUpdatedAt = remote?.updatedAt || 0;
  if (remoteUpdatedAt > localUpdatedAt) {
    const applied = await fromCloudShape(key, remote.value);
    await applyRemoteToLocal(key, applied, remoteUpdatedAt);
  } else {
    const localValue = (await chrome.storage.local.get([key]))[key];
    if (localValue !== undefined) await syncPush(key, localValue);
  }
}

export async function reconcileAll() {
  for (const key of SYNC_KEYS) {
    await reconcileKey(key);
  }
}

// --- live listeners: remote change while this service worker is alive ->
// local storage instantly (which is also what fires the popup's existing
// storage.onChanged -> refresh() so the UI updates live, same as any other
// background.js write). ---
let unsubscribers = [];
export function attachRealtimeListeners() {
  detachRealtimeListeners();
  const user = currentUser();
  if (!user) return;
  for (const key of SYNC_KEYS) {
    const unsub = onSnapshot(syncDocRef(user.uid, key), (snap) => {
      if (snap.metadata.hasPendingWrites || !snap.exists()) return;
      const remote = snap.data();
      getSyncMeta().then((meta) => {
        if ((remote.updatedAt || 0) <= (meta[key] || 0)) return;
        fromCloudShape(key, remote.value).then((applied) => applyRemoteToLocal(key, applied, remote.updatedAt));
      });
    });
    unsubscribers.push(unsub);
  }
}
export function detachRealtimeListeners() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
}
