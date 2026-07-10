const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize WhatsApp Client
// We use LocalAuth to save the session locally (creates a .wwebjs_auth folder)
const client = new Client({
    authStrategy: new LocalAuth(),
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
            '--disable-gpu',
            '--disable-site-isolation-trials', // Massive memory saver for headless Chrome
            '--js-flags="--max-old-space-size=256"' // Force aggressive garbage collection
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
    console.log('WhatsApp Bot authenticated successfully.');
});

client.on('auth_failure', msg => {
    console.error('WhatsApp Bot authentication failure:', msg);
});

client.initialize().catch(err => {
    console.error('Initialization failed:', err);
});

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

    const { numbers, message } = req.body;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !message) {
        return res.status(400).json({ error: 'Invalid payload. "numbers" array and "message" string are required.' });
    }

    const results = [];

    try {
        for (const number of numbers) {
            // whatsapp-web.js requires numbers to be appended with '@c.us'
            // Ensure numbers are stripped of '+' or leading '0'
            let cleanNumber = number.toString().replace(/\D/g, ''); // Remove non-digits
            if (cleanNumber.startsWith('0')) {
                cleanNumber = '62' + cleanNumber.substring(1); // Auto-convert leading 0 to Indonesian 62
            }
            
            const chatId = `${cleanNumber}@c.us`;
            
            // Dispatch the message
            await client.sendMessage(chatId, message);
            results.push({ number: cleanNumber, status: 'sent' });
            console.log(`Sent WhatsApp notification to ${cleanNumber}`);
        }

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
