# Carino — Flutter edition

Carino for Android and Windows, with every screen in Flutter (Material 3). Carino's engine — its
server code, database, AI agent, sync, backup and everything else — is the same proven TypeScript
engine as before (`mobile/engine.ts`), running in one hidden WebView inside the app at the same
address as the earlier apps. Installing this app over the earlier one keeps all data.

```
Flutter screens  ──request──▶  window.__carinoFlutter (mobile/flutter-link.ts)  ──▶  engine (/api)
       ▲                                                                          │
       └──────────── CarinoFlutter.post (replies, streamed chat, events) ◀────────┘
```

- `lib/engine/` — the link to the engine: `LinkedEngine` (shared), `AndroidEngine` (MethodChannel
  to `MainActivity`) and `WindowsEngine` (WebView2 messages), plus the chat stream parser.
- `lib/screens/` — every screen: Home, Chats and Chat (attachments, dictation, voice mode), To-dos,
  Your stuff, Approvals, Notifications, Memory, Discover, Routines, Money, Applications, Files,
  Ramble, Settings (all sections, Devices pairing), What Carino can reach, My apps, Connected apps,
  Messaging, AI & connections, and first-run setup. Only Share (it reads what another app shared
  from the engine's own storage) still uses the engine's page, shown by the WebView underneath.
- `lib/windows/` — what Carino for Windows adds, in Dart (it was Rust in the Tauri app): chosen
  folders, approved apps, the local-network sync listener for the phone, pairing addresses, the
  local-AI probe and the DPAPI key vault. The engine calls them by the same command names as before.
- `android/` — the same Java code as `../android` (alarms, widgets, folders, Keystore, background
  listening), with `MainActivity` hosting both Flutter and the engine.

## Languages

Carino speaks English, Português (Brasil), Deutsch, Français, Español, Nederlands, Italiano and
Polski (Settings → Language & region; "Automatic" follows the phone). Text is written in English
in the code — `Tx('…')` for text widgets and `tr('…')` for strings — and looked up in
`assets/i18n/<code>.json`, which the web screens (`src/lib/i18n.ts`, `t('…')`) share. To change or
add a translation, edit `l10n/<code>.txt` and run `python3 l10n/build.py`; anything not translated
shows in English. The assistant's replies follow the language you write in.

## Build

```
npm run build            # repository root: the engine for Android (android/app/src/main/assets/www)
npm run build:desktop    # repository root: the engine for Windows (desktop/dist)
cd app
flutter test
flutter build apk        # release builds are signed with CARINO_KEYSTORE_FILE / CARINO_KEYSTORE_PASSWORD
flutter build windows    # on Windows; the engine is copied next to Carino.exe (engine/)
```

Releases: `.github/workflows/release.yml` builds the signed APK; `.github/workflows/desktop.yml`
builds Carino for Windows and its installer (`windows/installer.iss`, Inno Setup).

The version is in `pubspec.yaml` (`1.7.0+10700`: the code follows the earlier app's numbering so it
installs as an update).
