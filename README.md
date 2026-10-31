# Carino

Carino is a personal AI assistant app for Android that runs **entirely on your phone**. It has no account,
no server and no subscription. It thinks with a free AI service you choose (Groq or Google Gemini) and
keeps everything else on the phone.

Carino is a cheerful round coral character with a leaf sprout. It greets you, keeps your to-dos and
reminders, plans your day, remembers what matters, and does the small stuff you'd rather not.

## What it does

| | |
|---|---|
| **Chat** | Ask anything; send photos, PDFs and documents for Carino to read. Replies can be read aloud, remembered or shared to WhatsApp. |
| **Home** | A greeting from Carino, an ask bar, quick starts and swipeable highlight cards: today, your daily brief, what's coming up, your week. |
| **Live voice** | Tap Carino to talk hands-free, using the phone's own speech recognition and voice. |
| **Ramble it out** | Talk or type everything on your mind; Carino sorts it into to-dos, reminders and things to remember. |
| **Daily brief & routines** | A morning brief and evening review, plus your own routines from an idea catalog (meal plans, money check-ins, birthdays, news on a topic…). |
| **Discover** | A catalog of things Carino can take off your plate, ordered by what you said you care about. |
| **Your stuff** | To-dos and reminders, routines, what Carino remembers (with "new things I learned"), connected apps and messaging. |
| **Calls** | Carino prepares a call: a script with what to say, saved as a to-do with a tap-to-dial link. |
| **Places** | Finds shops, restaurants and services nearby (OpenStreetMap). |
| **My apps** | Tap **Sign in** for **Google** (Gmail, Calendar, Drive, Sheets, Docs), **Microsoft** (Outlook, Calendar, OneDrive, Word, Excel, PowerPoint), **Instagram**, **Facebook** Pages, **X**, **LinkedIn** and **TikTok**. No developer setup needed. Carino reads and acts for you; sending and posting always wait for your OK. More apps (Notion, Linear, Zapier…) through MCP. See [docs/my-apps.md](docs/my-apps.md). |
| **Messaging** | Chat with Carino on **WhatsApp** (its own number, like Toqi: link yours by sending a 6-digit code) or **Telegram**, including voice notes and family or team groups. |
| **Challenges & stickers** | Weekly goals and challenges that earn Carino a crown, hats and a headband. Share Carino stickers to WhatsApp. |
| **Privacy** | Sensitive memories wait for your OK, deletions need approval, and you can erase everything on the phone at any time. |

## Free alternatives to paid services

| Paid service in apps like this | What Carino uses instead (free) |
|---|---|
| Hosted AI and accounts | Your own key for **Groq** or **Google Gemini** (free tiers), or **OpenRouter** free models, or a model on your own PC (Ollama) |
| Cloud database | SQLite (WebAssembly, with full-text search) stored on the phone |
| WhatsApp bot channel | **Telegram Bot API** (free), plus sharing replies and stickers to WhatsApp |
| Voice transcription service | The phone's own speech recognition; Groq's free Whisper for Telegram voice notes |
| Text-to-speech service | The phone's own voices |
| Push notification service | Android alarms and notifications, which ring even when the app is closed |
| Phone-call agents | A prepared call script with a tap-to-dial link |
| Maps and places APIs | OpenStreetMap (Nominatim) |
| Integration platform | MCP connectors (Zapier, Composio and Pipedream have free plans) |
| Analytics and crash trackers | None. Carino sends no usage data anywhere. |

## Install

1. On your Android phone, download `Carino-<version>.apk` from the latest release.
2. Open it, and allow *Install unknown apps* when asked.
3. Open Carino and follow the setup. When it asks for a brain, choose **Groq** or **Google Gemini**, tap the
   link to get a free key, and paste it.

## Develop

```bash
npm install
npm run dev        # the app in a desktop browser, with the on-phone server running in the page
npm test           # server and engine tests
npm run build      # builds the app bundle into android/app/src/main/assets/www
cd android && gradle assembleDebug   # needs the Android SDK; or let the "Android check" workflow build it
```

How it fits together:

- `src/` is the app's screens (React).
- `server/` is Carino's API and assistant logic (Hono). On the phone it runs inside the app; nothing listens on a network port.
- `mobile/` starts that server in the app (`engine.ts`), with browser versions of the Node features it uses (`shims/`), and talks to Android (`native.ts`).
- `android/` is the native app: a WebView that loads the bundled app, plus Android's networking, notifications and alarms, speech, sharing and the home-screen widget.

## Releases

Run the **Release** workflow from the Actions tab with a version number. It needs two repository secrets:

- `CARINO_KEYSTORE_B64`: the signing key (a PKCS#12 file, base64-encoded)
- `CARINO_KEYSTORE_PASSWORD`: its password

Every release must be signed with the same key, or phones won't accept it as an update. Keep the key safe and
out of the repository.
