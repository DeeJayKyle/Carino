# My apps

Carino signs in to your accounts **directly from your phone**. Nothing goes through a Carino server:
each app talks to the provider with **your own free developer app**, which you create once (about
5 minutes each). The steps are also shown inside Carino, on each app's page in **Me → My apps**.

| App | What Carino can do | Needs |
|---|---|---|
| **Google** | Gmail: search, read, draft, send and reply. Calendar: see and add events (with Meet links). Drive: find and read files (Docs, Sheets, Slides, Word, Excel, PowerPoint, PDF), save attachments. Sheets: read, add rows, update, create. Docs: create and add to. | A Google Cloud project with a **Desktop app** OAuth client |
| **Microsoft** | Outlook: search, read, draft, send and reply. Calendar: see and add events (with Teams links). OneDrive: find, read and upload files. Write **Word** documents, **Excel** workbooks and **PowerPoint** decks; read and update Excel. | An Entra app registration (public client, redirect `http://localhost:47823/callback`) |
| **Instagram** | See your profile, posts and comments, reply to comments, post a photo you attach. | A Meta app; a Business or Creator account linked to a Facebook Page |
| **Facebook** | See your Pages' posts and comments, post to a Page (text, link or photo), reply as the Page. | The same Meta app (Facebook only allows posting to Pages, not personal profiles) |
| **X** | Post and reply as you; see your profile. | An X developer app (Free plan: about 500 posts a month, very few reads) |
| **LinkedIn** | Post as you, with a link. | A LinkedIn developer app with *Sign In with LinkedIn* and *Share on LinkedIn* |
| **TikTok** | Send a video you attach to your TikTok inbox as a draft, to finish and post. | A TikTok developer app with Login Kit and Content Posting API (Sandbox is enough for your own account) |

**Approvals.** Reading is automatic. Changes (a calendar event, a spreadsheet row, a new document) ask
first unless you allow them in **Settings → Permissions**. Sending email and posting anywhere
**always** wait for you to tap Approve, and that can't be switched off.

**Several accounts.** Sign in again to add a second Google or Microsoft account; Carino picks the right
one when you name it ("check my work Gmail").

**Where sign-ins are kept.** Tokens are stored encrypted on the phone. Disconnecting an account in
My apps deletes them.

## How sign-in works on the phone

Tapping *Sign in* opens the provider's own sign-in page in your browser. When you allow access, the
browser is sent to `http://localhost:47823/callback` (or `127.0.0.1`). Carino listens on that address
— on the phone itself only, never on the network — for a few minutes, takes the one-time code,
checks it against the random value it started with (and the PKCE secret, where the provider
supports it), and sends you back to the app. That is why each guide asks you to add this
redirect address to your developer app.

## Google: "Google hasn't verified this app"

That's expected for your own app. Tap **Advanced → Go to Carino (unsafe)**. Publish the app (Google
Auth Platform → Audience → **Publish app**) so Google doesn't sign you out every 7 days; you don't
need Google's verification to use it yourself.

# WhatsApp

Like Toqi, Carino gets **its own WhatsApp number** that you chat with, through Meta's official
WhatsApp Business platform:

1. **Meta app**: in [Meta for Developers](https://developers.facebook.com/apps/creation/), add
   *WhatsApp* to an app. Meta gives a free test number; add your own WhatsApp number as a
   recipient. Copy the *Phone number ID*, create a permanent access token for a system user
   (*whatsapp_business_messaging*), and copy the *App secret*. Paste them in **Messaging → WhatsApp**.
2. **Relay**: Meta only delivers messages to a web address that's always online, which a phone
   isn't. Make a free [Cloudflare account](https://dash.cloudflare.com/sign-up), create an API token
   with the **Edit Cloudflare Workers** template, and paste it into Carino. Carino puts the relay
   (`relay/worker.js`, about 100 lines) on your account and links it. The token isn't kept.
3. **Webhook**: in Meta → WhatsApp → Configuration, paste the *Callback URL* and *Verify token*
   Carino shows, then subscribe to **messages**.
4. **Link your chat**: send the 6-digit code from your WhatsApp to Carino's number.

The relay keeps each delivery exactly as Meta signed it until your phone collects it (at most 7
days), then deletes it. It never sees your app secret and can't send anything: Carino checks Meta's
signature on the phone and replies directly. Anyone can post to the relay's address, but Carino
ignores everything that isn't signed by Meta.

**In the background.** With *Answer in the background* on, Carino keeps answering while you use other
apps and shows a quiet "Carino is listening" notification (Android requires one). If you swipe
Carino away, messages wait on the relay until you open it again.

**Cost.** Replying to messages you send is free. Meta only charges for conversations a business
starts after 24 hours of silence, which Carino doesn't do.

**Deploying the relay yourself** (optional): `cd relay && npx wrangler deploy`, then paste its
address under *I already have a relay*.
