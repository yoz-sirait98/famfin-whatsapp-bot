const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { PostgresStore } = require('wwebjs-postgres');
const { Pool } = require('pg');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize WhatsApp Client
// We use RemoteAuth with wwebjs-postgres to save the session permanently in Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});
const store = new PostgresStore({ pool });

const client = new Client({
    authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000 // Backup every 5 minutes
    }),
    authTimeoutMs: 120000, // Increase auth timeout to 2 minutes for slow Heroku starts
    puppeteer: {
        executablePath: puppeteer.executablePath(),
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Aggressive memory reduction
            '--disable-gpu',
            '--disable-site-isolation-trials',
            '--js-flags="--max-old-space-size=128"', // Limit V8 memory to 128MB
            '--blink-settings=imagesEnabled=false'
        ]
    }
});

let isClientReady = false;

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

// Setup Express Endpoint for Supabase Webhook
app.post('/api/notify', async (req, res) => {
    // Basic API Key security check
    const apiKey = req.headers['x-api-key'];
    if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
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

    const results = [];

    try {
        // Send to Group if provided
        if (groupId) {
            try {
                await client.sendMessage(groupId, message);
                results.push({ groupId, status: 'sent' });
                console.log(`Sent WhatsApp notification to Group: ${groupId}`);
            } catch (err) {
                console.error(`Failed to send to Group ${groupId}:`, err.message);
                results.push({ groupId, status: 'error', error: err.message });
            }
        }

        // Send to individual numbers if provided
        if (numbers && Array.isArray(numbers)) {
            for (const number of numbers) {
            // whatsapp-web.js requires numbers to be appended with '@c.us'
            // Ensure numbers are stripped of '+' or leading '0'
            let cleanNumber = number.toString().replace(/\D/g, ''); // Remove non-digits
            if (cleanNumber.startsWith('0')) {
                cleanNumber = '62' + cleanNumber.substring(1); // Auto-convert leading 0 to Indonesian 62
            }
            
            // Check if the number is registered on WhatsApp and get its exact ID
            const numberDetails = await client.getNumberId(cleanNumber);
            if (!numberDetails) {
                console.error(`Number ${cleanNumber} is not registered on WhatsApp.`);
                results.push({ number: cleanNumber, status: 'unregistered' });
                continue;
            }
            
            // Dispatch the message using the verified serialized ID
            await client.sendMessage(numberDetails._serialized, message);
            results.push({ number: cleanNumber, status: 'sent' });
            console.log(`Sent WhatsApp notification to ${cleanNumber}`);
            
            // IMPORTANT: Wait 2 seconds before sending the next message
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        } // End numbers loop

        return res.status(200).json({ success: true, results });
    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        return res.status(500).json({ error: 'Failed to send messages', details: error.message });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`famfin-whatsapp-bot API server running on port ${PORT}`);
});
