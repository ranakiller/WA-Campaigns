// Google sign-in. Runs entirely inside background.js (the service worker) —
// popup.js never touches Firebase directly, it just sends 'signIn'/'signOut'
// messages the same way it already does for every other action, and a click
// handler's user gesture propagates through chrome.runtime.sendMessage far
// enough for chrome.identity's interactive account picker to be allowed to
// open from here.
//
// There's deliberately no separate "sign up" flow: chrome.identity.getAuthToken
// picks an already-signed-in Chrome/Google account (the "continue with your
// current Google profile" pattern), and Firebase creates the account on
// first sign-in automatically — the same button does both.
//
// initializeAuth(..., { persistence: indexedDBLocalPersistence }) is
// Firebase's own documented approach for using Auth inside an extension
// service worker, which has no window/localStorage for the normal
// getAuth() default to fall back on.
import { getFirebaseApp } from './firebase-init.js';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  GoogleAuthProvider,
  signInWithCredential,
  onAuthStateChanged,
  signOut
} from './vendor/firebase/firebase-auth.js';

let authInstance = null;
function getAuthInstance() {
  if (!authInstance) {
    authInstance = initializeAuth(getFirebaseApp(), { persistence: indexedDBLocalPersistence });
  }
  return authInstance;
}

function getChromeAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'No Google account token available.'));
        return;
      }
      resolve(token);
    });
  });
}

// Interactive — shows Chrome's native account chooser/consent the first
// time. Used by the login screen's "Continue with Google" button.
export async function signInWithGoogle() {
  const token = await getChromeAuthToken(true);
  const credential = GoogleAuthProvider.credential(null, token);
  const result = await signInWithCredential(getAuthInstance(), credential);
  return result.user;
}

// Silent — reuses whatever token Chrome already cached from the interactive
// sign-in above, no UI. Used to re-establish this service worker's own
// Firebase session on every wake (it doesn't persist across a service
// worker restart the way a normal page's memory would). Resolves to null if
// the user was never signed in or the cached token has been revoked —
// callers treat that as "sync is simply unavailable right now," not an
// error to surface.
export async function silentSignIn() {
  try {
    const token = await getChromeAuthToken(false);
    const credential = GoogleAuthProvider.credential(null, token);
    const result = await signInWithCredential(getAuthInstance(), credential);
    return result.user;
  } catch (err) {
    return null;
  }
}

export async function signOutEverywhere() {
  try {
    const token = await getChromeAuthToken(false);
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
  } catch (err) {
    // No cached token to remove — already effectively signed out of Chrome's side.
  }
  await signOut(getAuthInstance());
}

export function watchAuthState(callback) {
  return onAuthStateChanged(getAuthInstance(), callback);
}

export function currentUser() {
  return getAuthInstance().currentUser;
}
