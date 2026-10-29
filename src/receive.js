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

const app = express();
const port = Number.parseInt(process.env.PORT || '4000', 10);
const storageFile = path.join(__dirname, 'received.json');
const mpesaBaseUrl = 'https://tuk.onenetwork-system.com/mpesa/v1';
const mpesaPartyB = '3018584';
const mpesaPollAttempts = 30;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

async function postMpesa(endpoint, body) {
    let response;
    try {
        response = await fetch(`${mpesaBaseUrl}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (error) {
        return { status: 'error', message: error.message };
    }

    const responseText = await response.text();
    try {
        return JSON.parse(responseText);
    } catch {
        return {
            status: 'error',
            message: `M-Pesa returned a non-JSON response (${response.status})`,
        };
    }
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initiateMpesaPayment(parsed) {
    const result = await postMpesa('stkpush.php', {
        name: process.env.MPESA_CUSTOMER_NAME || 'SMS2Pay Customer',
        phone: parsed.payer,
        amount: Number.parseInt(parsed.amount, 10),
        paymentType: 'till',
        partyB: mpesaPartyB,
        accountReference: parsed.uuid,
    });

    if (result.status !== 'success' || !result.data?.CheckoutRequestID) {
        return {
            status: 'FL',
            reason: result.message || 'mpesa_initiation_failed',
            mpesa: result,
        };
    }

    const checkoutRequestId = result.data.CheckoutRequestID;
    for (let attempt = 1; attempt <= mpesaPollAttempts; attempt += 1) {
        const statusResult = await postMpesa('statuscheck.php', {
            CheckoutRequestID: checkoutRequestId,
        });

        if (statusResult.status === 'success') {
            return {
                status: 'OK',
                checkoutRequestId,
                mpesa: statusResult,
            };
        }
        if (statusResult.status === 'failure' || statusResult.status === 'error') {
            return {
                status: 'FL',
                checkoutRequestId,
                reason: statusResult.message || statusResult.data?.ResultDesc || 'mpesa_payment_failed',
                mpesa: statusResult,
            };
        }
        if (attempt < mpesaPollAttempts) {
            await wait(1000);
        }
    }

    return {
        status: 'PD',
        checkoutRequestId,
        reason: 'mpesa_payment_pending',
    };
}

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
            const payment = duplicate
                ? { status: 'PD', reason: 'duplicate_payment' }
                : await initiateMpesaPayment(parsed);
            const replyText = `RES1-${parsed.uuid}-${payment.status}-${parsed.amount}`;

            reply = {
                status: payment.status,
                uuid: parsed.uuid,
                amount: parsed.amount,
                text: replyText,
                duplicate,
                payment,
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
