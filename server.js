// server.js — minimal edits: added /api/mpesa/stk (fixed Ksh 20) and /api/mpesa/status
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// Allow both old admin site and the new flyer frontend
app.use(cors({
  origin: [
    'https://www.perontips.co.ke',
    'https://perontips-fliers.vercel.app'
  ],
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

let logs = [];
let accessTokenCache = null;
let tokenExpiryTime = null;

// get Daraja OAuth token (cached)
async function getAccessToken() {
  if (accessTokenCache && tokenExpiryTime > Date.now()) {
    return accessTokenCache;
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
    tokenExpiryTime = Date.now() + 3600000; // 1 hour
    return accessTokenCache;
  } catch (error) {
    console.error('Error fetching access token:', error.response?.data || error.message);
    throw new Error('Unable to fetch access token');
  }
}

function getTimestamp() {
  const date = new Date();
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

/*
  NOTE: Your original /pay endpoint remains untouched below.
  We add a new endpoint /api/mpesa/stk that uses a fixed Ksh 20 for flyer downloads
  but reuses the same STK push logic so nothing breaks.
*/

// ------------ Existing working /pay route (kept as-is) -------------
app.post('/pay', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const token = await getAccessToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(BUSINESS_SHORTCODE + PASSKEY + timestamp).toString('base64');

    const stkRequest = {
      BusinessShortCode: BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: TILL_NUMBER,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'QuizPayment',
      TransactionDesc: 'Payment for quiz section'
    };

    const darajaResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkRequest,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    logs.push({
      phone,
      amount,
      status: 'Pending',
      timestamp,
      checkoutId: darajaResponse.data.CheckoutRequestID,
      details: darajaResponse.data
    });

    res.json(darajaResponse.data);
  } catch (error) {
    console.error('STK Push error (original /pay):', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', message: error.message });
  }
});

// ------------ New: API endpoint for flyer frontend (fixed Ksh 20) -------------
app.post('/api/mpesa/stk', async (req, res) => {
  try {
    const { phone, event, template } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const FIXED_AMOUNT = 20; // fixed flyer price

    const token = await getAccessToken();
    if (!token) {
      return res.status(500).json({ error: 'Daraja access token unavailable' });
    }

    const timestamp = getTimestamp();
    const password = Buffer.from(BUSINESS_SHORTCODE + PASSKEY + timestamp).toString('base64');

    const stkRequest = {
      BusinessShortCode: BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: FIXED_AMOUNT,
      PartyA: phone,
      PartyB: TILL_NUMBER || BUSINESS_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: `PeronTips-${event || 'download'}`,
      TransactionDesc: `PeronTips download (${event || 'custom'})`
    };

    const darajaResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkRequest,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutId = darajaResponse.data.CheckoutRequestID;
    logs.push({
      phone,
      amount: FIXED_AMOUNT,
      event: event || null,
      template: template || null,
      status: 'Pending',
      timestamp,
      checkoutId,
      details: darajaResponse.data
    });

    // Return checkoutId so frontend can poll /api/mpesa/status
    res.json({ checkoutId, data: darajaResponse.data });
  } catch (error) {
    console.error('STK Push error (/api/mpesa/stk):', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', message: error.response?.data || error.message });
  }
});

// ------------ New: Poll status by checkoutId (for flyer frontend) -------------
app.get('/api/mpesa/status', (req, res) => {
  const checkoutId = req.query.checkoutId;
  if (!checkoutId) return res.status(400).json({ error: 'checkoutId is required' });

  const found = logs.find(l => l.checkoutId === checkoutId);
  if (!found) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  // normalize status string to 'Pending'|'Success'|'Failed'
  const status = found.status || 'Pending';
  return res.json({
    status,
    phone: found.phone,
    amount: found.amount,
    event: found.event,
    template: found.template,
    mpesaReceipt: found.mpesaReceipt || null,
    resultDesc: found.resultDesc || null,
    expiry: found.expiry || null,
    checkoutId: found.checkoutId
  });
});

// ------------ Existing phone-based /status (kept unchanged) -------------
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

// ------------ Callback from Safaricom Daraja (kept but updated to set expiry) -------------
app.post('/callback', (req, res) => {
  console.log('Callback received:', JSON.stringify(req.body, null, 2));
  const callback = req.body.Body?.stkCallback;
  if (!callback) {
    console.warn('Invalid callback data', req.body);
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
      // set expiry for successful payment (12 hours)
      logs[logIndex].expiry = Date.now() + (1000 * 60 * 60 * 12);
    }
  } else {
    logs.push({
      phone: 'unknown',
      amount: null,
      status: callback.ResultDesc,
      timestamp: getTimestamp(),
      checkoutId,
      details: callback
    });
  }

  res.json({ ResultCode: 0, ResultDesc: 'Received' });
});

// ------------ Logs (kept) -------------
app.get('/logs', (req, res) => {
  const phone = req.query.phone;
  const result = phone ? logs.filter(l => l.phone === phone) : logs;
  res.json(result);
});

const port = PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
