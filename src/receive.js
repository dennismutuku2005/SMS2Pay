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
const mpesaBaseUrl = 'https://tuk.onenetwork-system.com/mpesa/v1';
const mpesaPartyB = '3018584';
const mpesaPollAttempts = 60;
const mpesaRequestTimeoutMs = 15000;

function log(message, details) {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    const startedAt = Date.now();
    log('Request received', { method: req.method, path: req.path, contentType: req.get('content-type') || null });
    res.on('finish', () => {
        log('Request completed', {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - startedAt,
        });
    });
    next();
});

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
    if (!/^(?:0[17]\d{8}|254[17]\d{8})$/.test(payer) || !/^\d+$/.test(amount)) {
        return null;
    }
    if (amount.length > 8 || Number.parseInt(amount, 10) < 1) {
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
    log('Records saved', { file: storageFile, count: records.length });
}

async function sendSms(replyText, requestData) {
    const apiKey = process.env.AT_API_KEY || '';
    const systemNumber = process.env.SYSTEM_NUM || requestData.from || '';

    if (!apiKey || !systemNumber) {
        log('SMS reply skipped: missing configuration', {
            hasApiKey: Boolean(apiKey),
            hasRecipient: Boolean(systemNumber),
        });
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
        log('Sending SMS reply', { to: systemNumber, from: shortcode, message: replyText });
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
        log('SMS request failed', { error: error.message });
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
        log('SMS provider returned an error', { status: response.status });
        return { ok: false, status: response.status, response: responseBody };
    }
    log('SMS reply sent', { to: systemNumber });
    return { ok: true, response: responseBody };
}

async function postMpesa(endpoint, body) {
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), mpesaRequestTimeoutMs);
    try {
        log('M-Pesa request started', { endpoint, checkoutRequestId: body.CheckoutRequestID || null });
        response = await fetch(`${mpesaBaseUrl}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (error) {
        const message = error.name === 'AbortError'
            ? `M-Pesa request timed out after ${mpesaRequestTimeoutMs / 1000} seconds`
            : error.message;
        log('M-Pesa request failed', { endpoint, error: message });
        return { status: 'error', message };
    } finally {
        clearTimeout(timeout);
    }

    const responseText = await response.text();
    try {
        const result = JSON.parse(responseText);
        log('M-Pesa response received', {
            endpoint,
            httpStatus: response.status,
            status: result.status || null,
            checkoutRequestId: result.data?.CheckoutRequestID || body.CheckoutRequestID || null,
        });
        if (!response.ok) {
            return {
                status: 'error',
                message: result.message || `M-Pesa returned HTTP ${response.status}`,
                data: result.data,
            };
        }
        return result;
    } catch {
        log('M-Pesa returned invalid JSON', { endpoint, httpStatus: response.status });
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
    log('M-Pesa payment initiation', {
        payer: parsed.payer,
        amount: parsed.amount,
        partyB: mpesaPartyB,
        paymentType: 'till',
    });
    const result = await postMpesa('stkpush.php', {
        name: process.env.MPESA_CUSTOMER_NAME || 'SMS2Pay Customer',
        phone: parsed.payer,
        amount: Number.parseInt(parsed.amount, 10),
        paymentType: 'till',
        partyB: mpesaPartyB,
        accountReference: parsed.uuid,
    });

    if (result.status !== 'success' || !result.data?.CheckoutRequestID) {
        log('M-Pesa payment initiation failed', { reason: result.message || 'unknown' });
        return {
            status: 'FL',
            reason: result.message || 'mpesa_initiation_failed',
            mpesa: result,
        };
    }

    const checkoutRequestId = result.data.CheckoutRequestID;
    log('M-Pesa payment accepted; background polling started', { checkoutRequestId });
    return {
        status: 'PD',
        checkoutRequestId,
        reason: 'mpesa_payment_pending',
        mpesa: result,
    };
}

async function pollMpesaPayment(checkoutRequestId) {
    log('M-Pesa polling started', {
        checkoutRequestId,
        pollAttempts: mpesaPollAttempts,
    });
    let attempt = 0;
    while (attempt < mpesaPollAttempts) {
        attempt += 1;
        const statusResult = await postMpesa('statuscheck.php', {
            CheckoutRequestID: checkoutRequestId,
        });
        log('M-Pesa status checked', { attempt, status: statusResult.status || 'unknown' });

        if (statusResult.status === 'success') {
            log('M-Pesa payment successful', { checkoutRequestId });
            return {
                status: 'OK',
                checkoutRequestId,
                mpesa: statusResult,
            };
        }
        if (statusResult.status === 'failure' || statusResult.status === 'error') {
            log('M-Pesa payment failed', { checkoutRequestId, reason: statusResult.message || 'unknown' });
            return {
                status: 'FL',
                checkoutRequestId,
                reason: statusResult.message || statusResult.data?.ResultDesc || 'mpesa_payment_failed',
                mpesa: statusResult,
            };
        }
        log('M-Pesa payment still pending; checking again in one second', { checkoutRequestId });
        await wait(1000);
    }

    log('M-Pesa payment still pending after one minute', { checkoutRequestId });
    return {
        status: 'PD',
        checkoutRequestId,
        reason: 'mpesa_payment_pending_timeout',
    };
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
    log('POS client dispatched PAY1', { text });
    return res.json({ ok: true, message: 'Dispatched', text });
});

async function completeMpesaPayment(parsed, requestData, initialPayment) {
    try {
        const payment = await pollMpesaPayment(initialPayment.checkoutRequestId);
        const replyText = `RES1-${parsed.uuid}-${payment.status}-${parsed.amount}`;
        const smsSent = await sendSms(replyText, requestData);
        log('Background payment completed', {
            uuid: parsed.uuid,
            status: payment.status,
            smsSent: smsSent.ok,
        });
    } catch (error) {
        log('Background payment processing failed', {
            uuid: parsed.uuid,
            error: error.message,
        });
    }
}

app.post(['/', '/webhook'], async (req, res, next) => {
    try {
        const data = req.body;
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
            return res.status(400).json({ ok: false, error: 'Empty request body' });
        }

        const rawText = String(data.text ?? data.message ?? data.body ?? '');
        const text = rawText.replace(/\s+/g, '');
        const parsed = parsePayMessage(text);
        log('Inbound payload parsed', {
            from: data.from || null,
            to: data.to || null,
            rawText,
            text,
            valid: Boolean(parsed),
        });
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

            if (payment.checkoutRequestId && payment.reason === 'mpesa_payment_pending') {
                void completeMpesaPayment(parsed, data, payment);
                reply.sms_sent = {
                    ok: false,
                    pending: true,
                    message: 'M-Pesa payment is being checked in the background',
                };
            } else {
                reply.sms_sent = await sendSms(replyText, data);
            }
        } else {
            const errorText = 'SMS2Pay error: invalid PAY1 format';
            reply = {
                status: 'FL',
                reason: 'invalid_payload',
                text: null,
            };
            reply.sms_sent = await sendSms(errorText, data);
            reply.error_text = errorText;
        }

        const records = readExistingRecords();
        records.push({
            received_at: new Date().toISOString(),
            payload: data,
            parsed,
            reply,
        });
        writeRecords(records);
        log('Webhook response prepared', {
            valid: Boolean(parsed),
            status: reply.status,
            duplicate: reply.duplicate || false,
        });

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
        log('Invalid JSON received', { error: error.message });
        return res.status(400).json({
            ok: false,
            error: 'Invalid JSON',
            detail: error.message,
        });
    }
    return next(error);
});

app.use((error, req, res, next) => {
    console.error(`[${new Date().toISOString()}] SMS2Pay request failed:`, error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
});

if (require.main === module) {
    app.listen(port, () => {
        log('SMS2Pay server running', {
            port,
            mpesaPartyB,
            mpesaPolling: 'every second for up to one minute',
        });
    });
}

module.exports = app;
