const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { PostgresStore } = require('wwebjs-postgres');
const { Pool } = require('pg');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { default: PQueue } = require('p-queue');
const webpush = require('web-push');
require('dotenv').config();

// Configure VAPID keys for Web Push Notifications
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

const app = express();
app.set('trust proxy', 1); // Trust the first proxy (e.g. Heroku, Render, Railway) to get correct client IP for rate limiting
app.use(cors());
app.use(express.json());

const messageQueue = new PQueue({ concurrency: 1 });

// Initialize WhatsApp Client
// We use RemoteAuth with wwebjs-postgres to save the session permanently in Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});
const store = new PostgresStore({ pool });

const client = new Client({
    authStrategy: new RemoteAuth({
        store: store,
        dataPath: './', // Fix: wwebjs-postgres hardcodes the zip path to the root directory
        backupSyncIntervalMs: 300000 // Backup every 5 minutes
    }),
    authTimeoutMs: 120000, // Increase auth timeout to 2 minutes for slow Heroku starts
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        executablePath: puppeteer.executablePath(),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-site-isolation-trials',
            '--blink-settings=imagesEnabled=false'
        ]
    }
});

let isClientReady = false;

client.on('disconnected', async (reason) => {
    console.log('WhatsApp disconnected:', reason);
    isClientReady = false;
    await new Promise(resolve => setTimeout(resolve, 5000));
    startBot();
});

client.on('qr', (qr) => {
    // Generate and scan this code with your phone
    console.log('QR Code received, scan please!');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Bot is ready and connected!');
    isClientReady = true;
});

client.on('authenticated', () => {
    console.log('WhatsApp Bot authenticated successfully. Waiting for remote save...');
});

client.on('remote_session_saved', () => {
    console.log('✅ SUCCESS: Remote session saved to Supabase!');
});

client.on('auth_failure', msg => {
    console.error('WhatsApp Bot authentication failure:', msg);
});

// Listen for incoming messages to reveal Group ID (fires for both incoming and outgoing)
client.on('message_create', async msg => {
    if (msg.body && msg.body.trim() === '!groupinfo') {
        const chat = await msg.getChat();
        if (chat.isGroup) {
            msg.reply(`WhatsApp Group ID:\n*${chat.id._serialized}*`);
        } else {
            msg.reply('This is not a group chat.');
        }
    }
});

async function startBot() {
    let retries = 5;
    while(retries > 0) {
        try {
            console.log(`Starting WhatsApp client... (Attempts left: ${retries})`);
            await client.initialize();
            break; // Success!
        } catch (err) {
            console.error('Initialization failed (Network error), retrying in 5 seconds...', err.message);
            retries--;
            if (retries === 0) {
                console.error('CRITICAL: Failed to initialize WhatsApp bot after 5 attempts!');
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
startBot();

// Utilities
function normalizeNumber(number) {
    let clean = number.toString().replace(/\D/g, '');
    if (clean.startsWith('0')) {
        clean = '62' + clean.substring(1);
    }
    return clean;
}

function timeout(ms) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), ms)
    );
}

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ready: isClientReady,
        uptime: process.uptime()
    });
});

// Request Logging Middleware
app.use('/api/notify', (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        const numbersCount = req.body.numbers ? req.body.numbers.length : 0;
        const groupId = req.body.groupId || '-';
        console.log(`${new Date().toISOString()} | POST /api/notify | IP: ${req.ip} | Numbers: ${numbersCount} | Group: ${groupId} | Status: ${res.statusCode} | Duration: ${duration}s`);
    });
    next();
});

// Rate Limiter
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 100, // limit each IP to 100 requests per windowMs
    message: { error: "Too many requests from this IP, please try again after 15 minutes" }
});

// Setup Express Endpoint for Supabase Webhook
app.post('/api/notify', apiLimiter, async (req, res) => {
    // Secure API Key security check
    const apiKey = req.headers['x-api-key'] || '';
    if (process.env.API_KEY) {
        if (apiKey.length !== process.env.API_KEY.length || 
            !crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(process.env.API_KEY))) {
            return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        }
    }

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

    // Queue background task
    messageQueue.add(async () => {
        try {
            // Send to Group if provided
            if (groupId) {
                try {
                    await client.sendMessage(groupId, message);
                    console.log(`[Queue] Sent WhatsApp notification to Group: ${groupId}`);
                } catch (err) {
                    console.error(`[Queue] Failed to send to Group ${groupId}:`, err.message);
                }
            }

            // Send to individual numbers if provided
            if (numbers && Array.isArray(numbers)) {
                for (const number of numbers) {
                    try {
                        const cleanNumber = normalizeNumber(number);
                        
                        // Check if the number is registered on WhatsApp and get its exact ID with timeout
                        const numberDetails = await Promise.race([
                            client.getNumberId(cleanNumber),
                            timeout(10000)
                        ]);
                        
                        if (!numberDetails) {
                            console.error(`[Queue] Number ${cleanNumber} is not registered on WhatsApp.`);
                            continue;
                        }
                        
                        // Dispatch the message using the verified serialized ID
                        await client.sendMessage(numberDetails._serialized, message);
                        console.log(`[Queue] Sent WhatsApp notification to ${cleanNumber}`);
                    } catch (err) {
                        console.error(`[Queue] Error sending to ${number}:`, err.message);
                    } finally {
                        // IMPORTANT: Wait 2 seconds before sending the next message
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
        } catch (error) {
            console.error('[Queue] Unhandled Error in message queue worker:', error);
        }
    });

    return res.status(202).json({ success: true, message: 'Messages queued for sending' });
});

// ===== PWA Web Push Notification Endpoint =====
app.post('/api/push', apiLimiter, async (req, res) => {
    // API Key security check (same as /api/notify)
    const apiKey = req.headers['x-api-key'] || '';
    if (process.env.API_KEY) {
        if (apiKey.length !== process.env.API_KEY.length || 
            !crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(process.env.API_KEY))) {
            return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        }
    }

    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        return res.status(503).json({ error: 'VAPID keys not configured on server.' });
    }

    const { subscription, payload } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Missing subscription data (endpoint, keys.p256dh, keys.auth).' });
    }

    const pushPayload = JSON.stringify(payload || { title: 'FamFin', body: 'New notification' });

    try {
        await webpush.sendNotification(subscription, pushPayload);
        console.log(`[WebPush] Sent push to ${subscription.endpoint.substring(0, 60)}...`);
        res.json({ success: true });
    } catch (err) {
        console.error('[WebPush] Send error:', err.statusCode, err.body || err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired — frontend should remove it from DB
            res.status(410).json({ error: 'Subscription expired', expired: true });
        } else {
            res.status(500).json({ error: 'Push delivery failed', details: err.message });
        }
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`famfin-whatsapp-bot API server running on port ${PORT}`);
});
