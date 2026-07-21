# FamFin WhatsApp Bot

A simple WhatsApp Web Bot built with Node.js, `whatsapp-web.js`, and `express`. It uses Supabase (PostgreSQL) to store the WhatsApp authentication session, which makes it ideal for deployment on platforms with ephemeral file systems like Heroku.

## Features
- Provides an API to send WhatsApp messages to individuals and groups.
- Connects automatically via remote authentication session stored in Postgres.
- Generates a QR code in the console for initial authentication.
- Listen to `!groupinfo` command inside a group to retrieve the Group ID.

## Prerequisites
- Node.js installed
- A PostgreSQL database (e.g., Supabase)

## Environment Variables
Create a `.env` file based on the provided `.env.example` (or set these in your hosting provider):

- `DATABASE_URL`: Your PostgreSQL connection string. Used for storing the WhatsApp session permanently.
- `API_KEY`: Secret key to secure your API endpoint (passed in header `x-api-key`).
- `PORT`: (Optional) Port on which the API server will run. Default is 3000.

## Installation & Setup

1. Install dependencies:
```bash
npm install
```

2. Start the bot:
```bash
npm start
```
On the very first run, check the terminal output for a QR code. Scan this QR code with your WhatsApp app (Linked Devices) to authenticate the bot. The session will be saved remotely to your PostgreSQL database.

## API Usage

### Send a Message
**Endpoint:** `POST /api/notify`

**Headers:**
- `Content-Type`: `application/json`
- `x-api-key`: `YOUR_API_KEY` (if `API_KEY` is set in environment)

**Body Parameters:**
- `message` (string, required): The text message you want to send.
- `numbers` (array of strings, optional): Array of phone numbers to send the message to (e.g., `["08123456789"]` or `["+628123456789"]`).
- `groupId` (string, optional): The ID of the WhatsApp group to send the message to.

**Example Request:**
```json
{
  "numbers": ["08123456789"],
  "groupId": "1234567890-123456@g.us",
  "message": "Hello from FamFin Bot!"
}
```

## Useful Commands
- **Get Group ID:** Add the bot to any WhatsApp group and send `!groupinfo`. The bot will reply with the Group ID, which you can use in the `/api/notify` endpoint.
