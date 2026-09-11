import express from 'express';
import pg from 'pg';
import cors from 'cors';
import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';
import PQueue from 'p-queue';
import webpush from 'web-push';
import 'dotenv/config';

import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    initAuthCreds,
    proto,
    BufferJSON,
} from '@whiskeysockets/baileys';

// ─── Config ──────────────────────────────────────────────────────────────────

const { Pool } = pg;
const SESSION_ID = process.env.SESSION_ID || 'famfin';

// Silent logger — suppress Baileys' internal verbose output
const logger = {
    level: 'silent',
    trace: () => {}, debug: () => {}, info: () => {},
    warn: (m) => console.warn('[Baileys]', m),
    error: (m) => console.error('[Baileys]', m),
    fatal: (m) => console.error('[Baileys]', m),
    child: function () { return this; },
};

// ─── Web Push ─────────────────────────────────────────────────────────────────

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@famfin.app',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log('Web Push VAPID keys configured.');
} else {
    console.warn('VAPID keys not set. /api/push endpoint will be unavailable.');
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const messageQueue = new PQueue({ concurrency: 1 });

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Baileys: PostgreSQL Auth State ──────────────────────────────────────────
//
// Replaces wwebjs-postgres. Stores Baileys credentials (creds + signal keys)
// in a single `baileys_auth` table using JSONB.
//
// Run once on your Supabase / PostgreSQL:
//
//   CREATE TABLE IF NOT EXISTS baileys_auth (
//       session_id TEXT NOT NULL,
//       key        TEXT NOT NULL,
//       value      JSONB,
//       PRIMARY KEY (session_id, key)
//   );

async function usePostgresAuthState(sessionId) {
    // Auto-create table if it doesn't exist (idempotent)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth (
            session_id TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      JSONB,
            PRIMARY KEY (session_id, key)
        )
    `);

    const read = async (key) => {
        const { rows } = await pool.query(
            'SELECT value FROM baileys_auth WHERE session_id = $1 AND key = $2',
            [sessionId, key]
        );
        if (!rows[0]) return null;
        // Revive Buffers (Baileys stores binary keys that need special deserialization)
        return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
    };

    const write = async (key, data) => {
        // Replace Buffers with serializable form before storing as JSONB
        const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await pool.query(
            `INSERT INTO baileys_auth (session_id, key, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [sessionId, key, value]
        );
    };

    const remove = async (key) => {
        await pool.query(
            'DELETE FROM baileys_auth WHERE session_id = $1 AND key = $2',
            [sessionId, key]
        );
    };

    // Load or bootstrap fresh credentials
    const creds = (await read('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await read(`keys:${type}:${id}`);
                            // Proto messages need deserialization from plain objects
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    await Promise.all(
                        Object.entries(data).flatMap(([type, ids]) =>
                            Object.entries(ids).map(([id, value]) =>
                                value
                                    ? write(`keys:${type}:${id}`, value)
                                    : remove(`keys:${type}:${id}`)
                            )
                        )
                    );
                },
            },
        },
        saveCreds: () => write('creds', creds),
    };
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────

let sock = null;
let isClientReady = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await usePostgresAuthState(SESSION_ID);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Connecting with WhatsApp v${version.join('.')} (latest: ${isLatest})`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,   // Baileys prints QR natively — no qrcode-terminal needed
        browser: Browsers.ubuntu('Chrome'),
        logger,
        // Required callback for retry requests and poll vote decryption.
        // A full message store is out of scope here, so we return undefined.
        getMessage: async () => undefined,
    });

    // Persist credentials whenever they update (e.g. after every message round-trip)
    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // printQRInTerminal: true already handles display — just log a hint
            console.log('QR Code ready! Scan with WhatsApp → Linked Devices.');
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp Bot connected and ready!');
            isClientReady = true;
        }

        if (connection === 'close') {
            isClientReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = Object.keys(DisconnectReason).find(
                (k) => DisconnectReason[k] === statusCode
            ) || statusCode;
            console.log(`WhatsApp disconnected. Reason: ${reason} (${statusCode})`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.error(
                    'CRITICAL: Logged out from WhatsApp. ' +
                    'Delete the session row from baileys_auth and restart to re-scan QR.'
                );
                // Do NOT reconnect — user must re-authenticate
            } else {
                console.log('Reconnecting in 5 seconds...');
                await new Promise((r) => setTimeout(r, 5000));
                connectToWhatsApp();
            }
        }
    });

    // Incoming message handler — supports !groupinfo command
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                '';

            if (text.trim() === '!groupinfo') {
                const jid = msg.key.remoteJid;
                if (jid?.endsWith('@g.us')) {
                    await sock.sendMessage(jid, { text: `WhatsApp Group ID:\n*${jid}*` }, { quoted: msg });
                } else {
                    await sock.sendMessage(jid, { text: 'This is not a group chat.' }, { quoted: msg });
                }
            }
        }
    });
}

// Boot with retry
async function startBot(retries = 5) {
    while (retries > 0) {
        try {
            console.log(`Starting WhatsApp client... (attempts left: ${retries})`);
            await connectToWhatsApp();
            break;
        } catch (err) {
            console.error('Initialization failed, retrying in 5 s...', err.message);
            retries--;
            if (retries === 0) {
                console.error('CRITICAL: Failed to initialize after 5 attempts!');
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

startBot();

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeNumber(number) {
    let clean = number.toString().replace(/\D/g, '');
    if (clean.startsWith('0')) {
        clean = '62' + clean.substring(1);
    }
    return clean;
}

function timeout(ms) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), ms)
    );
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Rate limiter: 100 requests per 15 minutes per IP
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    message: { error: 'Too many requests from this IP, please try again after 15 minutes.' },
});

// Request logging for /api/notify
app.use('/api/notify', (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        const numbersCount = req.body?.numbers?.length ?? 0;
        const groupId = req.body?.groupId || '-';
        console.log(
            `${new Date().toISOString()} | POST /api/notify | IP: ${req.ip} | ` +
            `Numbers: ${numbersCount} | Group: ${groupId} | Status: ${res.statusCode} | Duration: ${duration}s`
        );
    });
    next();
});

// API Key guard (reusable)
function requireApiKey(req, res, next) {
    if (!process.env.API_KEY) return next(); // No key configured → open
    const provided = req.headers['x-api-key'] || '';
    const expected = process.env.API_KEY;
    if (
        provided.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ready: isClientReady,
        uptime: process.uptime(),
    });
});

// ─── POST /api/notify ─────────────────────────────────────────────────────────

app.post('/api/notify', apiLimiter, requireApiKey, async (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not ready yet.' });
    }

    const { numbers, groupId, message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Invalid payload. "message" is required.' });
    }
    if ((!numbers || numbers.length === 0) && !groupId) {
        return res.status(400).json({ error: 'Must provide either "numbers" array or "groupId".' });
    }

    // Queue work in the background — API responds immediately with 202
    messageQueue.add(async () => {
        try {
            // ── Send to Group ────────────────────────────────────────────────
            if (groupId) {
                try {
                    await sock.sendMessage(groupId, { text: message });
                    console.log(`[Queue] Sent to group: ${groupId}`);
                } catch (err) {
                    console.error(`[Queue] Failed to send to group ${groupId}:`, err.message);
                }
            }

            // ── Send to Individual Numbers ───────────────────────────────────
            if (numbers && Array.isArray(numbers)) {
                for (const number of numbers) {
                    try {
                        const cleanNumber = normalizeNumber(number);

                        // Verify the number exists on WhatsApp (with 10s timeout)
                        const results = await Promise.race([
                            sock.onWhatsApp(cleanNumber),
                            timeout(10000),
                        ]);

                        const contact = results?.[0];
                        if (!contact?.exists) {
                            console.error(`[Queue] ${cleanNumber} is not registered on WhatsApp.`);
                            continue;
                        }

                        await sock.sendMessage(contact.jid, { text: message });
                        console.log(`[Queue] Sent to ${cleanNumber}`);
                    } catch (err) {
                        console.error(`[Queue] Error sending to ${number}:`, err.message);
                    } finally {
                        // Throttle: wait 2 s between messages to avoid rate limiting
                        await new Promise((r) => setTimeout(r, 2000));
                    }
                }
            }
        } catch (error) {
            console.error('[Queue] Unhandled error in message worker:', error);
        }
    });

    return res.status(202).json({ success: true, message: 'Messages queued for sending.' });
});

// ─── POST /api/push (Web Push Notifications) ──────────────────────────────────

app.post('/api/push', apiLimiter, requireApiKey, async (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        return res.status(503).json({ error: 'VAPID keys not configured on server.' });
    }

    const { subscription, payload } = req.body;

    if (!subscription?.endpoint || !subscription?.keys) {
        return res.status(400).json({
            error: 'Missing subscription data (endpoint, keys.p256dh, keys.auth).',
        });
    }

    const pushPayload = JSON.stringify(payload || { title: 'FamFin', body: 'New notification' });

    try {
        await webpush.sendNotification(subscription, pushPayload);
        console.log(`[WebPush] Sent to ${subscription.endpoint.substring(0, 60)}...`);
        res.json({ success: true });
    } catch (err) {
        console.error('[WebPush] Send error:', err.statusCode, err.body || err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
            res.status(410).json({ error: 'Subscription expired', expired: true });
        } else {
            res.status(500).json({ error: 'Push delivery failed', details: err.message });
        }
    }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`famfin-whatsapp-bot API server running on port ${PORT}`);
});
