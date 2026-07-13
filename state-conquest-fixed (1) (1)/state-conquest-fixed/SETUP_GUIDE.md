# State Conquest — Setup Guide

## What you have
- `server/` — the multiplayer game server (Node.js + Socket.io)
- `client/index.html` — the game itself (single HTML file, works in any browser)

## Step 0 — Set up Firebase (accounts, leaderboard, stats)
The game now uses Firebase for sign-in, saved stats, and the leaderboard. Your config is
already in `client/index.html`, but you need to turn on two things in the Firebase console
(https://console.firebase.google.com → your project `councure-the-state`):

1. **Authentication** → Sign-in method → enable **Email/Password**.
2. **Realtime Database** → Rules tab → use rules like this (lets any signed-in user read
   the leaderboard, but only write their own profile):
```json
{
  "rules": {
    "users": {
      ".read": "auth != null",
      "$uid": {
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```
Click **Publish**. Without this, sign-up/sign-in will work but reading/writing stats will fail.

## Step 1 — Deploy the server (so phones can connect to each other)
1. Push the `server/` folder to a GitHub repo.
2. Go to https://render.com (free tier) → "New Web Service" → connect your repo.
   - Build command: `npm install`
   - Start command: `node server.js`
3. Render gives you a URL like `https://state-conquest.onrender.com`.

## Step 2 — Point the client at your server
In `client/index.html`, change this line near the top of the `<script>`:
```js
const SERVER_URL = "https://YOUR-SERVER-URL.onrender.com";
```
to your real Render URL.

## Step 3 — Test it in a browser first
Just open `client/index.html` in Chrome/Firefox (or serve it with any static host) —
open it in two browser tabs to simulate two players.

## Step 4 — Turn it into an Android APK (using Capacitor)
On your own computer (needs Node.js + Android Studio installed):

```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "State Conquest" "com.yourname.stateconquest"
mkdir www
cp client/index.html www/
npx cap add android
npx cap open android
```

This opens the project in **Android Studio**. From there:
- `Build > Generate Signed Bundle / APK` → choose APK → create a new keystore (keep it safe, you need it for every future update) → Build.
- Your `.apk` will be in `android/app/release/`.

## Step 5 — Publish to Google Play
1. Create a Google Play Developer account (one-time $25 fee): https://play.google.com/console
2. Create a new app, upload your signed APK/AAB, fill in store listing (title, screenshots, description, privacy policy URL).
3. Submit for review (usually a few days).

## Notes / limitations of this MVP
- Grid map only (not fancy hex shapes) — easy to reskin with better art later.
- Bots use simple AI; can be made smarter.
- Accounts are email/password via Firebase Auth; wins and games played are saved per-account
  in Firebase Realtime Database and shown on a leaderboard (top 20 by wins).
- No formal alliance system — it's free-for-all; "alliances" are just players agreeing verbally/in-game not to attack each other.

## Want me to extend it?
I can add: real hex-grid map, chat/alliance requests, password reset / Google sign-in,
better graphics, or sound — just tell me which.
