# TG Scout

[中文](README.md) · [English](README.en.md)

**A self-hosted Telegram message filter & analyzer that runs on Cloudflare Workers.**
It signs in to your own account, read-only, watches the chats you choose, and picks out the messages you care about with keyword rules or AI prompts. You can also run a one-off analysis on a chat (translate, summarize, ...). Results are pushed to "Saved Messages" or shown in the web console.

> ⚠️ This is a personal tool. Logging in to a user account with automation may get the account restricted or banned by Telegram. Read [Risks & disclaimer](#risks--disclaimer) first.

## Features

- **Two kinds of strategies**
  - **Keyword**: any / all / regex, with a configurable interval.
  - **AI**: write a prompt and the AI decides which new messages match. Run it on a schedule, or set it to **manual** to analyze the latest N messages of selected chats once (e.g. "translate to English", "summarize").
- **Read-only**: never posts or replies; it only pushes results to the chat you choose.
- **Records**: matches and task results are stored as a list; open one to read it in full, copy or delete it; old records are purged automatically.
- **AI usage**: today / total input, output and total tokens, plus per-result consumption.
- **Egress proxy**: SOCKS5 with a one-click test (exit IP, region, latency to Telegram).
- **Login protection**: failed-attempt lockout, optional TOTP two-step verification, optional password recovery by email.
- **Failures are visible**: each strategy shows its last run status and error; with email configured you get a notice after repeated failures.
- **Serverless**: Cloudflare Worker + D1, no always-on process, all data stays in your own account.

## How it works

```
Cloudflare Cron (every minute) ─▶ Worker ─▶ MTProto (gramjs over cloudflare:sockets, optional SOCKS5) ─▶ Telegram
                                     │
                                     ├─▶ keyword / AI (OpenAI-compatible API) matching
                                     ├─▶ D1: strategies, records, Telegram session, usage
                                     └─▶ matches pushed to Saved Messages or a chat you pick
```

- For every strategy and chat the Worker remembers the last processed message, so only **new** messages are handled.
- The first run only records the position and does not process history. Saving a strategy resets its position.

## Requirements

| Needed | Notes |
| --- | --- |
| Cloudflare account | Free is enough to start, see [Costs & limits](#costs--limits) |
| GitHub account | One-click deploy only |
| Node.js 18+ (22 recommended) | Command-line deploy only; not needed for one-click deploy |
| Telegram `api_id` / `api_hash` | Create at <https://my.telegram.org/apps> |
| An AI API | Any OpenAI-compatible service, e.g. DeepSeek |
| A SOCKS5 proxy with a fixed exit IP (strongly recommended) | See [Egress proxy](#egress-proxy) |
| Resend account (optional) | For password recovery and failure alerts by email |

## Deploy

### Option 1: one-click deploy from the browser (recommended)

No Node.js and no commands needed.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chhbzhou/tg-scout)

1. Click **Deploy to Cloudflare** above and sign in to Cloudflare (register first if needed).
2. Connect and authorize your **GitHub account**. Cloudflare copies this project into a repo under your account.
3. On the setup page confirm the project name and fill **ADMIN_TOKEN** with your login password: a long random string, never leave the default (the default cannot log in). The database is created automatically.
4. Click **Create and deploy** and wait; the page shows your URL (like `https://tg-scout.<your-subdomain>.workers.dev`).
5. Open the URL, sign in with the password from step 3, then configure as [below](#configuration).

Pushing changes to your own GitHub repo redeploys automatically.

**Custom domain** (needed if `workers.dev` is unreachable): Cloudflare dashboard → Workers & Pages → your Worker → Settings → Domains & Routes → Add → Custom domain, using a domain or subdomain hosted on Cloudflare.

**Inspect the database**: dashboard → Storage & Databases → D1, default name `tg-scout-db`; its Console runs SQL directly.

### Option 2: command line

For people who prefer a terminal or want to change the code. Needs Node.js 18+ (22 recommended).

1. **Get the code**

   ```bash
   git clone https://github.com/chhbzhou/tg-scout.git
   cd tg-scout
   npm install
   ```

2. **Sign in to Cloudflare**

   ```bash
   npx wrangler login
   ```

   Or set `CLOUDFLARE_API_TOKEN` (handy on a server) with:
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - For a custom domain also: Zone → Zone → Read, Zone → Workers Routes → Edit

3. **Deploy**

   ```bash
   npx wrangler deploy
   ```

   The first deploy creates the D1 database automatically (`tg-scout-db`); tables are created on the first request. The printed URL is your console.

4. **Set the login password**

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

   Use a long random string. It is your first login password and can be changed in the console. You cannot log in before it is set.

5. **(Optional) custom domain**: uncomment `[[routes]]` in `wrangler.toml`, put in your domain and run `npx wrangler deploy` again. With a custom domain the default `workers.dev` address is disabled; add `workers_dev = true` to keep it.

### Local development

```bash
cp .dev.vars.example .dev.vars   # put a local ADMIN_TOKEN in it
npm run dev                       # http://localhost:8787, local D1 simulation
```

## Configuration

Open **Settings**, edit, then press **Save** at the top (it turns blue when there are unsaved changes).

### Telegram

1. Open <https://my.telegram.org/apps> (also linked in the Telegram card), sign in and create an app:
   - App title: at least 5 characters, must not contain "Telegram", e.g. `Message Scout`
   - Short name: 5–32 alphanumerics, e.g. `msgscout`
   - Leave URL empty, Platform = Desktop, Description = anything
   - You get `api_id` and `api_hash`; enter them in Settings. **Never share them.**
2. Fill in and save the **egress proxy** (below) and press **Test** first.
3. In the Account card enter country code and phone number, press **Send code**. The code arrives in your official Telegram chat (not SMS). Enter it and press **Sign in**; enter the two-step password if you have one.
4. After login a session named "Desktop" appears in your Telegram devices list; you can terminate it there any time.

### Egress proxy

Format: `socks5://user:pass@host:port`, or `socks5://host:port` without auth. URL-encode special characters in the password.

**Why a fixed-exit proxy**: without one Telegram sees Cloudflare's rotating data-center IPs for the same account, which easily triggers risk controls, logouts or restrictions. The proxy must be reachable from the public internet because the connection is made by Cloudflare, not by your computer.

**Test** connects through the proxy to ip-api.com to show the exit IP and region, then to a Telegram server and shows the latency.

### Push target

- **Saved Messages**: the simplest option.
- **Custom**: `@channelname` or a chat ID. A private channel just for results works well.

### AI

Any OpenAI-compatible endpoint that serves `/chat/completions`.

| Field | Example (DeepSeek) |
| --- | --- |
| Base URL | `https://api.deepseek.com/v1` |
| Model | `deepseek-chat` |
| Key | create one in the provider console |

- **Test** sends a real `hello` and shows the reply and latency.
- Avoid reasoning models: they emit long reasoning first, cost more, and the program expects JSON only.
- Once tokens are used, a today / total table appears under the fields; "Reset" clears it.

### Record retention

Days to keep matches and task results, default 30, 0 = keep forever. Purged hourly; strategies and usage totals are unaffected.

## Using strategies

Open **Strategies** and press **New strategy**.

### Keyword

- Type keywords and press Enter. Modes: any, all, regex (case-insensitive).
- Interval: 1–1440 minutes; values outside the range are rejected.

### AI

- The prompt is your filter, e.g. "find messages hiring Go backend engineers".
- **Run mode**:
  - **Scheduled**: processes new messages at the interval; matches are pushed and stored.
  - **Manual**: runs only when you press **Run**. It reads the latest N messages (default 50, max 200) of each selected chat, processes them with your prompt, shows the result in a panel and stores it; optionally pushes it too. Manual strategies need at least one chat.

### Processing details (affects quota and cost)

- Scheduled runs send new messages to the AI in batches of 30 and only matches come back; each message is cut to its first 1200 characters; at most 100 new messages per chat per run, the rest next run.
- Manual runs keep only the most recent ~60,000 characters if the text is longer.
- Messages without text (images, files) are skipped.
- Selecting "all chats" checks every chat each round: slower and costlier, so pick only what you need.
- Message text is sent to the AI service you configured; mind sensitive chats.

## Security

- **Login**: sign-in issues a session token valid for 30 days. 5 wrong passwords from one IP, or 20 from all sources, within 15 minutes locks login for 15 minutes. Changing the password or enabling two-step verification signs out other devices.
- **Two-step verification (TOTP)**: scan the QR in Settings and confirm with one code; disabling also needs a code.
- **Email recovery** (optional): enter a [Resend](https://resend.com/api-keys) API key and a recipient address; only then "Forgot password" appears on the login page. Codes are 6 digits, valid 10 minutes, one per 60 seconds, void after 5 wrong tries. **A successful recovery also turns off two-step verification.**
  - Without a verified domain Resend's `onboarding@resend.dev` can only send to the address you registered Resend with. To send elsewhere, verify your domain in Resend and set the sender to `Name <noreply@your-domain>`.
- **Failure alerts**: each strategy shows its last run status; with email configured, a scheduled strategy failing 3 times in a row triggers one summary email, at most once per hour.
  - Alerts do not go through Telegram, because when the proxy or session is broken Telegram cannot deliver them either.
- **Data**: the Telegram session, api_hash, AI key and Resend key are stored in plain text in your own D1. Whoever gets D1 or a logged-in session controls your account. Use a strong password and two-step verification, and consider putting Cloudflare Access in front of the console.

## Costs & limits

Cloudflare limits ([Workers Limits](https://developers.cloudflare.com/workers/platform/limits/); the official page is authoritative):

| Item | Workers Free | Workers Paid |
| --- | --- | --- |
| CPU time per HTTP request | 10 ms | 30 s default |
| CPU time per Cron Trigger | **10 ms** | 30 s (interval < 1 h) |
| Wall-clock per Cron Trigger | 15 min | 15 min |
| Subrequests per invocation | **50** | 10,000 |
| Cron Triggers per account | 5 (this project uses 1) | 250 |
| Requests per day | 100,000 (this project wakes ~1,440 times/day) | unlimited |

Measured on the author's deployment:

- A plain API request uses about **1 ms** CPU.
- A per-minute cron wake-up with nothing due uses about **5–7 ms**, already close to the 10 ms Free limit.
- CPU for a run that actually pulls from Telegram (connect, decrypt, call the AI) has **not been measured systematically** and may exceed 10 ms. If it does, the invocation is terminated and the strategy shows a failure; you then need **Workers Paid (about $5/month)**.
- Subrequests: every AI call and email counts as one. Free allows 50 per invocation, so a large backlog may not finish in one run; the next run continues from the saved position.

Other:

- Cron granularity is 1 minute, in UTC; changes to triggers can take up to 15 minutes to propagate.
- AI costs are billed by your AI provider.
- D1's free quota is plenty for personal use.

## Risks & disclaimer

- **Account risk**: logging in to a user account with a program is not an official Telegram client and may violate its terms; the account may be restricted, frozen or banned. Being read-only (it only sends notifications to your push target) lowers the risk but does not remove it. Use an account whose risk you accept; the author is not responsible for any consequences.
- **Compliance**: follow Telegram's terms and your local laws. This project is for individuals processing messages they can already see; it must **not** be used for harassment, spam, bulk collection of other people's data or anything illegal.
- **Data leaving your account**: AI strategies send message text to the AI service you configure; the proxy test contacts the third-party ip-api.com.
- **Prompt injection**: message content is untrusted input. The system prompt tells the AI to only judge and never follow instructions inside messages, but it can still be misled; treat results as hints.
- The software is provided "as is" without warranty; see [LICENSE](LICENSE).

## FAQ

**The page won't open / connection reset**
`workers.dev` is interfered with on some networks. Bind your own domain hosted on Cloudflare (deploy step 6).

**No login code arrived**
The code comes from the official Telegram chat, not SMS. Check api_id / api_hash and that the proxy test passes; repeated requests make Telegram throttle you, wait a while.

**Logged out after a while**
Telegram may have terminated the session (IP change, risk control). Sign in again and make sure a fixed-exit proxy is configured.

**A strategy keeps failing**
The red line on the card is the reason. Common ones: dead proxy, terminated session, wrong AI URL or key, AI not configured. Use the two Test buttons in Settings.

**Forgot password**
- With email configured: use "Forgot password" on the login page.
- Without email: clear the stored password and two-step records, then sign in with the `ADMIN_TOKEN` from deployment. In the browser: dashboard → D1 → `tg-scout-db` → Console and run the SQL below; or from the command line:

  ```sql
  DELETE FROM settings WHERE k IN ('pw_hash','pw_salt','totp_on','totp_secret');
  DELETE FROM sessions;
  ```

  ```bash
  npx wrangler d1 execute tg-scout-db --remote --command \
    "DELETE FROM settings WHERE k IN ('pw_hash','pw_salt','totp_on','totp_secret'); DELETE FROM sessions;"
  ```

**Test email says it can only send to the registered address**
See "Email recovery" above: use the address registered with Resend, or verify your own domain.

**Switch Telegram account**
Press "Sign out" in the Account card and sign in again.

## Layout

```
src/
  index.js     routes and API
  auth.js      login, sessions, rate limit, TOTP, email
  tg.js        Telegram client, login, chat list
  sockets.js   Worker socket adapter, SOCKS5, proxy test
  run.js       scheduled runs, manual tasks, failure alerts
  match.js     keyword matching, AI calls
  db.js        D1 schema and data access
  page.html    console page
```

## Contributing

Issues and PRs are welcome. Make sure you don't commit keys, domains, database IDs or other personal info.

## License

[MIT](LICENSE)
