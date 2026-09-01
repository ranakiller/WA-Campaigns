// Google sign-in. Runs entirely inside background.js (the service worker) —
// popup.js never touches Firebase directly, it just sends 'signIn'/'signOut'
// messages the same way it already does for every other action, and a click
// handler's user gesture propagates through chrome.runtime.sendMessage far
// enough for chrome.identity's interactive flow to be allowed to open from
// here.
//
// There's deliberately no separate "sign up" flow: this picks whichever
// Google account the flow's popup is signed into (the "continue with your
// current Google profile" pattern), and Firebase creates the account on
// first sign-in automatically — the same button does both.
//
// Uses chrome.identity.launchWebAuthFlow() rather than getAuthToken() —
// getAuthToken only exists on Chrome (it depends on Chrome's own built-in
// Google-account integration; calling it on Edge throws "This API is not
// supported on Microsoft Edge"). launchWebAuthFlow is a generic
// OAuth-in-a-popup primitive both browsers support, at the cost of a real
// Google consent screen instead of Chrome's native one-click account
// chooser. It needs a "Web application" type OAuth client (not "Chrome
// Extension" type) with this extension's redirect URL — see
// GOOGLE_OAUTH_CLIENT_ID's own comment in firebase-config.js.
//
// initializeAuth(..., { persistence: indexedDBLocalPersistence }) is
// Firebase's own documented approach for using Auth inside an extension
// service worker, which has no window/localStorage for the normal
// getAuth() default to fall back on.
import { getFirebaseApp } from './firebase-init.js';
import { GOOGLE_OAUTH_CLIENT_ID } from './firebase-config.js';
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

function authUrl(interactive) {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile',
    // 'none' asks Google to fail fast instead of showing any UI if there's
    // no already-authorized session to silently reuse — that's exactly the
    // signal silentSignIn() needs to tell "already trusted" apart from
    // "needs the user to actually go through consent."
    prompt: interactive ? 'select_account' : 'none'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function runAuthFlow(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl(interactive), interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message || 'Sign-in was cancelled or failed.'));
        return;
      }
      const accessToken = new URLSearchParams(new URL(redirectUrl).hash.slice(1)).get('access_token');
      if (!accessToken) {
        reject(new Error('Google did not return an access token.'));
        return;
      }
      resolve(accessToken);
    });
  });
}

// Interactive — opens Google's consent screen the first time. Used by the
// login screen's "Continue with Google" button.
export async function signInWithGoogle() {
  const token = await runAuthFlow(true);
  const credential = GoogleAuthProvider.credential(null, token);
  const result = await signInWithCredential(getAuthInstance(), credential);
  return result.user;
}

// Silent (prompt=none, no visible window) — used to re-establish this
// service worker's own Firebase session on every wake, since it doesn't
// persist across a service worker restart the way a normal page's memory
// would. Resolves to null if the user was never signed in or Google can't
// silently reauthorize (session expired, revoked, etc.) — callers treat
// that as "sync is simply unavailable right now," not an error to surface.
export async function silentSignIn() {
  try {
    const token = await runAuthFlow(false);
    const credential = GoogleAuthProvider.credential(null, token);
    const result = await signInWithCredential(getAuthInstance(), credential);
    return result.user;
  } catch (err) {
    return null;
  }
}

export async function signOutEverywhere() {
  await signOut(getAuthInstance());
}

export function watchAuthState(callback) {
  return onAuthStateChanged(getAuthInstance(), callback);
}

export function currentUser() {
  return getAuthInstance().currentUser;
}
