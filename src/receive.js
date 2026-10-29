/*
 * SMS2Pay webhook server.
 *
 * Receives PAY1 payment messages from Africa's Talking, validates and
 * records each request, detects duplicate UUIDs, and sends RES1 replies
 * when Africa's Talking credentials are configured.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
        process.loadEnvFile(envPath);
    } catch {
        // Continue if already loaded or not readable
    }
}

const app = express();
const port = Number.parseInt(process.env.PORT || '4000', 10);
const storageFile = path.join(__dirname, 'received.json');
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(['/', '/pos'], (req, res) => {
        res.sendFile(path.join(publicDir, 'index.html'));
    });
}

function parsePayMessage(message) {
    const parts = message.split('-');
    if (parts.length !== 4 || parts[0] !== 'PAY1') {
        return null;
    }

    const [, payer, amount, uuid] = parts;
    if (!/^\d+$/.test(payer) || !/^\d+$/.test(amount)) {
        return null;
    }
    if (payer.length > 12 || amount.length > 8) {
        return null;
    }
    if (!/^[\da-f]{24}$/i.test(uuid)) {
        return null;
    }

    return { payer, amount, uuid };
}

function readExistingRecords() {
    if (!fs.existsSync(storageFile)) {
        return [];
    }

    const contents = fs.readFileSync(storageFile, 'utf8');
    if (contents.trim() === '') {
        return [];
    }

    try {
        const records = JSON.parse(contents);
        if (!Array.isArray(records)) {
            throw new Error('Storage JSON must contain an array');
        }
        return records;
    } catch (error) {
        const corruptFile = `${storageFile}.corrupt.${Date.now()}`;
        fs.renameSync(storageFile, corruptFile);
        console.error(`Invalid storage file moved to ${corruptFile}:`, error.message);
        return [];
    }
}

function writeRecords(records) {
    const temporaryFile = `${storageFile}.tmp.${process.pid}`;
    const json = JSON.stringify(records, null, 2);
    fs.writeFileSync(temporaryFile, json, { encoding: 'utf8', flag: 'w' });
    fs.renameSync(temporaryFile, storageFile);
}

async function sendSms(replyText, requestData) {
    const apiKey = process.env.AT_API_KEY || '';
    const systemNumber = process.env.SYSTEM_NUM || requestData.from || '';

    if (!apiKey || !systemNumber) {
        return {
            ok: false,
            error: 'AT_API_KEY or SYSTEM_NUM not configured',
        };
    }

    const form = new URLSearchParams({
        username: process.env.AT_USERNAME || 'sandbox',
        to: systemNumber,
        message: replyText,
    });
    const shortcode = process.env.AT_SHORTCODE || '66578';
    if (shortcode) {
        form.set('from', shortcode);
    }

    let response;
    try {
        response = await fetch('https://api.sandbox.africastalking.com/version1/messaging', {
            method: 'POST',
            headers: {
                apiKey,
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: form,
        });
    } catch (error) {
        return { ok: false, error: error.message };
    }
    const responseText = await response.text();
    let responseBody;
    try {
        responseBody = JSON.parse(responseText);
    } catch {
        responseBody = responseText;
    }

    if (!response.ok) {
        return { ok: false, status: response.status, response: responseBody };
    }
    return { ok: true, response: responseBody };
}

// POS Integration Endpoints for Backend Connectivity
app.get('/api/pos/status/:uuid', (req, res) => {
    const uuid = String(req.params.uuid || '').toUpperCase();
    const records = readExistingRecords();
    const match = records.slice().reverse().find((r) => r?.parsed?.uuid === uuid || r?.reply?.uuid === uuid);
    if (!match) {
        return res.status(404).json({ ok: false, error: 'Transaction not found' });
    }
    return res.json({
        ok: true,
        uuid,
        status: match.reply?.status || 'Pending',
        replyText: match.reply?.text || null,
        record: match,
    });
});

app.get('/api/pos/inbox', (req, res) => {
    const records = readExistingRecords();
    return res.json({ ok: true, records: records.slice(-20) });
});

app.post('/api/pos/send', (req, res) => {
    const { payMessage, phone, amount, uuid } = req.body || {};
    const text = payMessage || `PAY1-${phone}-${amount}-${uuid}`;
    console.log('POS client dispatched PAY1:', text);
    return res.json({ ok: true, message: 'Dispatched', text });
});

app.post(['/', '/webhook'], async (req, res, next) => {
    try {
        const data = req.body;
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
            return res.status(400).json({ ok: false, error: 'Empty request body' });
        }

        console.log('SMS2Pay inbound:', JSON.stringify(data));

        const text = String(data.text ?? data.message ?? data.body ?? '').trim();
        const parsed = parsePayMessage(text);
        let reply;

        if (parsed) {
            const existing = readExistingRecords();
            const duplicate = existing.some((record) => record?.parsed?.uuid === parsed.uuid);
            const replyText = `RES1-${parsed.uuid}-OK-${parsed.amount}`;

            reply = {
                status: 'OK',
                uuid: parsed.uuid,
                amount: parsed.amount,
                text: replyText,
                duplicate,
            };

            reply.sms_sent = await sendSms(replyText, data);
        } else {
            reply = {
                status: 'FL',
                reason: 'invalid_payload',
                text: null,
            };
        }

        const records = readExistingRecords();
        records.push({
            received_at: new Date().toISOString(),
            payload: data,
            parsed,
            reply,
        });
        writeRecords(records);

        return res.status(parsed ? 200 : 422).json({
            ok: Boolean(parsed),
            received: data,
            parsed,
            reply,
            record_count: records.length,
        });
    } catch (error) {
        return next(error);
    }
});

app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({
            ok: false,
            error: 'Invalid JSON',
            detail: error.message,
        });
    }
    return next(error);
});

app.use((error, req, res, next) => {
    console.error('SMS2Pay request failed:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`SMS2Pay server running on port ${port}`);
    });
}

module.exports = app;
