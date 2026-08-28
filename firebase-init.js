// Shared Firebase app instance — used by both the popup (a normal window
// context) and background.js (a Manifest V3 service worker), so this file
// only does the one thing both environments need identically.
import { initializeApp, getApps, getApp } from './vendor/firebase/firebase-app.js';
import { firebaseConfig } from './firebase-config.js';

export function getFirebaseApp() {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}
