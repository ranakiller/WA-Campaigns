// Paste your actual Firebase web app config here (Firebase Console → Project
// settings → General → Your apps → the </> web app → the firebaseConfig
// object shown there). Everything in this file is only ever used to reach
// your own Firebase project — none of it is a secret that grants write
// access on its own (that's what Firestore/Storage security rules are for).
export const firebaseConfig = {
  apiKey: 'AIzaSyDZ6j4NgObQG3MaWD4k6LB46tAwb8wz914',
  authDomain: 'wacampaigner-b4c9c.firebaseapp.com',
  projectId: 'wacampaigner-b4c9c',
  storageBucket: 'wacampaigner-b4c9c.firebasestorage.app',
  messagingSenderId: '595199563661',
  appId: '1:595199563661:web:9a259eab8f6f2e57744fc4'
};

// Used by auth.js's chrome.identity.launchWebAuthFlow() sign-in — needs an
// OAuth Client ID of type "Web application" (NOT "Chrome Extension" — that
// type only works with chrome.identity.getAuthToken(), which is Chrome-only
// and throws on Edge/other Chromium browsers). In Google Cloud Console →
// APIs & Services → Credentials → Create Credentials → OAuth client ID →
// Web application, add this extension's redirect URL under "Authorized
// redirect URIs":
//   https://gjacnhihfadbodlcjanankehcfaomlhc.chromiumapp.org/
// (that's chrome.identity.getRedirectURL() for this extension's pinned ID —
// see manifest.json's "key" field / README's Account sync section — it's
// the same on every Chromium browser, not just Chrome, so one client here
// covers Chrome, Edge, etc.)
export const GOOGLE_OAUTH_CLIENT_ID = '435506991606-0mon34k21cj43nmb0i9c4mj3arfg7nqs.apps.googleusercontent.com';
