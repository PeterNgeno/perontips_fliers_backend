// server.js — safer version for Render
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// Allow the frontend URL you specified and allow local testing
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://perontips-fliers.vercel.app';
app.use(cors({
  origin: FRONTEND_URL,
  methods: ['GET', 'POST'],
  credentials: true
}));

const {
  PORT,
  DARAJA_CONSUMER_KEY,
  DARAJA_CONSUMER_SECRET,
  BUSINESS_SHORTCODE,
  PASSKEY,
  CALLBACK_URL,
  TILL_NUMBER
} = process.env;

const DEFAULT_CALLBACK = (process.env.BASE_URL || 'https://perontips-fliers-backend.onrender.com') + '/callback';

// Basic startup checks (but do not crash)
const missing = [];
if (!DARAJA_CONSUMER_KEY) missing.push('DARAJA_CONSUMER_KEY');
if (!DARAJA_CONSUMER_SECRET) missing.push('DARAJA_CONSUMER_SECRET');
if (!BUSINESS_SHORTCODE) missing.push('BUSINESS_SHORTCODE');
if (!PASSKEY) missing.push('PASSKEY');
if (!TILL_NUMBER && !BUSINESS_SHORTCODE) missing.push('TILL_NUMBER or BUSINESS_SHORTCODE');

if (missing.length) {
  console.warn('⚠️ Warning: Some environment variables seem to be missing:', missing.join(', '));
  console.warn('The server will still start so you can fix env vars and redeploy. Some endpoints (STK) will fail until env vars are set.');
}

let logs = [];
let accessTokenCache = null;
let tokenExpiryTime = null;

// wrap axios oauth call with robust logging and do NOT crash the process when failing
async function getAccessToken() {
  if (accessTokenCache && tokenExpiryTime > Date.now()) {
    return accessTokenCache;
  }
  if (!DARAJA_CONSUMER_KEY || !DARAJA_CONSUMER_SECRET) {
    console.error('Daraja credentials missing — cannot fetch access token.');
    return null;
  }

  const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString('base64');

  try {
    const response = await axios.get(
      'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000
      }
    );
    accessTokenCache = response.data.access_token;
    tokenExpiryTime = Date.now() + 3500000; // slightly less than 1 hour
    console.info('Fetched Daraja access token successfully.');
    return accessTokenCache;
  } catch (err) {
    console.error('Error fetching access token:', err?.response?.data || err.message || err);
    // don't throw — return null to allow server to keep running
    return null;
  }
}

function getTimestamp() {
  const date = new Date();
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

// ------------------ API: STK push ------------------
// POST /api/mpesa/stk
app.post('/api/mpesa/stk', async (req, res) => {
  try {
    const { phone, event, template } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const FIXED_AMOUNT = 20; // fixed price

    const token = await getAccessToken();
    if (!token) {
      // return friendly error — don't crash
      return res.status(500).json({ error: 'Daraja access token unavailable. Check server environment and network.' });
    }

    const timestamp = getTimestamp();
    const password = Buffer.from((BUSINESS_SHORTCODE || TILL_NUMBER || '') + (PASSKEY || '') + timestamp).toString('base64');

    const stkRequest = {
      BusinessShortCode: BUSINESS_SHORTCODE || TILL_NUMBER,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: FIXED_AMOUNT,
      PartyA: phone,
      PartyB: TILL_NUMBER || BUSINESS_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: (CALLBACK_URL || DEFAULT_CALLBACK),
      AccountReference: `PeronTips-${event || 'download'}`,
      TransactionDesc: `PeronTips download (${event || 'custom'})`
    };

    const darajaResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkRequest,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    const checkoutId = darajaResponse?.data?.CheckoutRequestID || null;
    const logEntry = {
      phone,
      amount: FIXED_AMOUNT,
      event: event || null,
      template: template || null,
      status: 'Pending',
      timestamp: getTimestamp(),
      checkoutId,
      details: darajaResponse.data
    };
    logs.push(logEntry);

    return res.json({ checkoutId, data: darajaResponse.data });
  } catch (err) {
    console.error('STK Push error:', err?.response?.data || err?.message || err);
    return res.status(500).json({ error: 'Payment initiation failed', message: err?.response?.data || err?.message || String(err) });
  }
});

// ------------------ Status endpoint ------------------
// GET /api/mpesa/status?checkoutId=...
app.get('/api/mpesa/status', (req, res) => {
  try {
    const checkoutId = req.query.checkoutId;
    if (!checkoutId) return res.status(400).json({ error: 'checkoutId is required' });
    const found = logs.find(l => l.checkoutId === checkoutId);
    if (!found) return res.status(404).json({ error: 'Transaction not found' });

    return res.json({
      status: found.status || 'Pending',
      phone: found.phone,
      amount: found.amount,
      event: found.event,
      template: found.template,
      mpesaReceipt: found.mpesaReceipt || null,
      resultDesc: found.resultDesc || null,
      expiry: found.expiry || null,
      checkoutId: found.checkoutId
    });
  } catch (err) {
    console.error('Status error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ Callback from Daraja ------------------
app.post('/callback', (req, res) => {
  try {
    console.log('Callback received:', JSON.stringify(req.body, null, 2));
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      console.warn('Invalid callback data received', req.body);
      return res.status(400).json({ error: 'Invalid data' });
    }

    const checkoutId = callback.CheckoutRequestID;
    const items = callback.CallbackMetadata?.Item || [];
    const receiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');

    const logIndex = logs.findIndex(l => l.checkoutId === checkoutId);
    if (logIndex !== -1) {
      logs[logIndex].status = (callback.ResultCode === 0) ? 'Success' : 'Failed';
      logs[logIndex].mpesaReceipt = receiptItem?.Value || null;
      logs[logIndex].resultDesc = callback.ResultDesc || null;
      if (callback.ResultCode === 0) {
        logs[logIndex].expiry = Date.now() + (1000 * 60 * 60 * 12); // 12 hours
      }
    } else {
      // preserve callback even if checkoutId not found
      logs.push({
        phone: 'unknown',
        amount: null,
        status: callback.ResultDesc || (callback.ResultCode === 0 ? 'Success' : 'Failed'),
        timestamp: getTimestamp(),
        checkoutId,
        details: callback
      });
    }

    // respond success to Daraja
    return res.json({ ResultCode: 0, ResultDesc: 'Received' });
  } catch (err) {
    console.error('Callback handling error:', err);
    return res.status(500).json({ error: 'Callback processing failed' });
  }
});

// ------------------ Logs and older endpoints ------------------
app.get('/logs', (req, res) => {
  const phone = req.query.phone;
  const result = phone ? logs.filter(l => l.phone === phone) : logs;
  res.json(result);
});

// keep the old /status (by phone)
app.get('/status', (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });

  const userLogs = logs.filter(log => log.phone === phone);
  if (userLogs.length === 0) {
    return res.status(404).json({ error: 'No transactions found' });
  }

  const lastLog = userLogs[userLogs.length - 1];
  res.json(lastLog);
});

// ------------------ Health route ------------------
app.get('/', (req, res) => {
  res.send('PeronTips Fliers backend is running.');
});

// ------------------ Error handlers to avoid silent exit ------------------
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason);
  // do not exit — keep server running so we can inspect logs
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
  // do not exit — keep server running to allow immediate debugging
});

// Start server
const port = PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  if (missing.length) {
    console.log('Warning — missing environment variables:', missing.join(', '));
    console.log(`Using default callback: ${CALLBACK_URL || DEFAULT_CALLBACK}`);
  }
});
