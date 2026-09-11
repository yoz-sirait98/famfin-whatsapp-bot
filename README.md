# FamFin WhatsApp Bot

A production-grade WhatsApp notification service built with Node.js, **[Baileys](https://github.com/WhiskeySockets/Baileys)** (direct WebSocket — no Puppeteer/Chrome), and Express. Sessions are persisted in Supabase (PostgreSQL), making it ideal for ephemeral-filesystem platforms like **Heroku**.

## Why Baileys vs whatsapp-web.js?

| | whatsapp-web.js | **Baileys (current)** |
|---|---|---|
| Approach | Headless Chrome (Puppeteer) | Direct WebSocket |
| RAM per session | ~400–500 MB | **~50 MB** |
| Chrome required | Yes | **No** |
| Heroku dyno size | Standard-2X+ | **Basic / Standard-1X** |

## Features

- `POST /api/notify` — Send WhatsApp messages to individuals and/or groups
- `POST /api/push` — Web Push notifications (PWA)
- `GET /health` — Health check endpoint (ready for UptimeRobot / Railway)
- Session stored in PostgreSQL — survives dyno restarts without re-scanning QR
- Auto-reconnect on disconnect
- Message queue (p-queue) — throttled, non-blocking delivery
- Rate limiting, timing-safe API key validation, request logging

## Prerequisites

- Node.js 18+
- A PostgreSQL database (e.g., [Supabase](https://supabase.com))

## Database Setup

Run [`migration.sql`](./migration.sql) once on your database:

```sql
CREATE TABLE IF NOT EXISTS baileys_auth (
    session_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      JSONB,
    PRIMARY KEY (session_id, key)
);
```

> The app also auto-creates this table on first startup.

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Supabase) |
| `API_KEY` | ✅ | Secret key sent as `x-api-key` header |
| `SESSION_ID` | ☑️ | WhatsApp session name in DB. Default: `famfin` |
| `PORT` | ☑️ | API server port. Default: `3000` |
| `VAPID_PUBLIC_KEY` | ☑️ | For `/api/push` (Web Push) |
| `VAPID_PRIVATE_KEY` | ☑️ | For `/api/push` (Web Push) |
| `VAPID_EMAIL` | ☑️ | For `/api/push` (Web Push) |

## Installation & Setup

```bash
npm install
npm start
```

On first run, a **QR code** will appear in the terminal. Scan it with your WhatsApp app under **Settings → Linked Devices**. The session is saved to PostgreSQL — subsequent restarts will reconnect automatically.

## API Reference

### `GET /health`

Returns bot status. Use with UptimeRobot (ping every 5 min) to keep Heroku dyno alive.

```json
{
  "status": "ok",
  "ready": true,
  "uptime": 123456
}
```

---

### `POST /api/notify`

Send a WhatsApp message to phone numbers and/or a group.

**Headers:**
```
Content-Type: application/json
x-api-key: YOUR_API_KEY
```

**Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | ✅ | Text message to send |
| `numbers` | string[] | ☑️ | Phone numbers (e.g. `["08123456789"]`) |
| `groupId` | string | ☑️ | WhatsApp group JID (e.g. `"120363...@g.us"`) |

At least one of `numbers` or `groupId` must be provided.

**Example:**
```json
{
  "numbers": ["08123456789", "+628987654321"],
  "groupId": "120363xxxxxxxx@g.us",
  "message": "Hello from FamFin Bot! 👋"
}
```

**Response:** `202 Accepted` (messages are queued asynchronously)
```json
{ "success": true, "message": "Messages queued for sending." }
```

---

### `POST /api/push`

Send a Web Push notification to a PWA subscription.

**Body:**
```json
{
  "subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } },
  "payload": { "title": "FamFin", "body": "You have a new notification" }
}
```

---

## Useful Commands

- **Get Group ID:** Add the bot to any WhatsApp group and send `!groupinfo`. The bot will reply with the Group ID to use in `/api/notify`.

- **Reset session (force re-scan QR):**
  ```sql
  DELETE FROM baileys_auth WHERE session_id = 'famfin';
  ```
  Then restart the app.

## Heroku Deployment

```bash
heroku create your-app-name
heroku config:set DATABASE_URL="..." API_KEY="..." SESSION_ID="famfin"
git push heroku main
heroku logs --tail
```

> **Tip:** Add a [UptimeRobot](https://uptimerobot.com) monitor on `GET /health` (every 5 min) to prevent the dyno from sleeping on Eco/Basic plans.
