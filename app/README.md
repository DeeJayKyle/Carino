# Carino — Flutter edition

Carino's screens in Flutter (Material 3), for Android now and Windows later. Carino's engine — its
server code, database, AI agent, sync, backup and everything else — is the same proven TypeScript
engine as before (`mobile/engine.ts`), running in one WebView inside the app at the same address as
the earlier Android app. Installing this app over the earlier one keeps all data.

```
Flutter screens  ──request──▶  window.__carinoFlutter (mobile/flutter-link.ts)  ──▶  engine (/api)
       ▲                                                                          │
       └──────────── CarinoFlutter.post (replies, streamed chat, events) ◀────────┘
```

- `lib/engine/` — the link to the engine (`AndroidEngine`) and a stream parser for chat replies.
- `lib/screens/` — Home, Chats, Chat, To-dos and More. Screens not yet rebuilt in Flutter open the
  engine's own page (`WebScreen`), shown by the same WebView underneath the Flutter screens.
- `android/` — the same Java code as `../android` (alarms, widgets, folders, Keystore, background
  listening), with `MainActivity` hosting both Flutter and the engine.

## Build

```
npm run build            # in the repository root: builds the engine into android/app/src/main/assets/www
cd app
flutter test
flutter build apk        # release builds are signed with CARINO_KEYSTORE_FILE / CARINO_KEYSTORE_PASSWORD
```

The version is in `pubspec.yaml` (`1.6.0+10600`: the code follows the earlier app's numbering so it
installs as an update).
