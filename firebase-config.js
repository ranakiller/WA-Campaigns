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

// Must match manifest.json's oauth2.client_id exactly — duplicated here
// because background.js/auth.js need it as a plain JS value, while
// manifest.json needs its own copy for chrome.identity.getAuthToken to work.
export const GOOGLE_OAUTH_CLIENT_ID = '435506991606-r7vvjb37pp51o9m00n55emoqghn9kais.apps.googleusercontent.com';
