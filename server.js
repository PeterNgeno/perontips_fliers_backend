// server.js (updated for Peron Tips frontend/backend setup)
// Drop this file into your backend project and restart the server.

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// Allowed origins: frontend + main site (add more if needed)
const ALLOWED_ORIGINS = [
  'https://perontips-fliers.vercel.app',
  'https://www.perontips.co.ke',
  'https://perontips.co.ke' // optional if you use non-www
];

app.use(cors({
  origin: function(origin, callback){
    // Allow requests with no origin (e.g., curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS policy: Origin not allowed'), false);
    }
  },
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

// Basic validation of required env vars
if (!DARAJA_CONSUMER_KEY || !DARAJA_CONSUMER_SECRET || !BUSINESS_SHORTCODE || !PASSKEY || !CALLBACK_URL || !TILL_NUMBER) {
  console.warn('Warning: One or more expected environment variables are missing. Make sure DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET, BUSINESS_SHORTCODE, PASSKEY, CALLBACK_URL and TILL_NUMBER are set.');
}

let logs = [];
let accessTokenCache = null;
let tokenExpiryTime = null;

/**
 * Get Daraja access token (cached with expiry)
 */
async function getAccessToken() {
  if (accessTokenCache && tokenExpiryTime && tokenExpiryTime > Date.now()) {
    return accessTokenCache;
  }

  if (!DARAJA_CONSUMER_KEY || !DARAJA_CONSUMER_SECRET) {
    throw new Error('Daraja consumer key/secret not configured');
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
    // Daraja tokens generally valid for 1 hour
    tokenExpiryTime = Date.now() + (60 * 60 * 1000) - (5 * 1000);
    return accessTokenCache;
  } catch (error) {
    console.error('Error fetching access token:', error.response?.data || error.message);
    throw new Error('Unable to fetch access token');
  }
}

/**
 * Returns timestamp in the format required by Daraja: YYYYMMDDHHmmss
 * Daraja expects Nairobi time but uses the timestamp purely for the password generation.
 */
function getTimestamp() {
  const date = new Date();
  // Use local time (server time). If your server is not in Kenya and you need Nairobi time,
  // compute with timezone offset. For simplicity we use UTC-based formatting but keep digits only.
  // If you want Nairobi-specific time regardless of server timezone, adjust here.
  const YYYY = date.getFullYear().toString();
  const MM = String(date.getMonth() + 1).padStart(2, '0');
  const DD = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${YYYY}${MM}${DD}${hh}${mm}${ss}`;
}

/**
 * Basic phone validator (Kenyan numbers expected like 07xxxxxxxx or 2547xxxxxxx)
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const cleaned = phone.replace(/\s|\+|-/g, '');
  // Accept 07XXXXXXXX or 2547XXXXXXXX or leading 7XXXXXXXX
  if (/^07\d{8}$/.test(cleaned)) return cleaned;
  if (/^7\d{8}$/.test(cleaned)) return '0' + cleaned;
  if (/^2547\d{8}$/.test(cleaned)) return cleaned;
  // optionally support +2547...
  if (/^2547\d{8}$/.test(cleaned)) return cleaned;
  // fallback: return cleaned if it looks numeric
  return cleaned;
}

// Health route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

/**
 * POST /pay
 * Body: { phone: string, amount: number }
 * - Validates amount (max KES 30 as requested)
 * - Initiates STK push
 */
app.post('/pay', async (req, res) => {
  try {
    const { phone: rawPhone, amount } = req.body;

    if (typeof amount === 'undefined' || amount === null) {
      return res.status(400).json({ error: 'Amount is required' });
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Enforce the maximum charge requested (KES 30)
    const MAX_AMOUNT = 30;
    if (numericAmount > MAX_AMOUNT) {
      return res.status(400).json({ error: `Amount exceeds maximum allowed (KES ${MAX_AMOUNT})` });
    }

    const phone = normalizePhone(String(rawPhone || ''));
    if (!phone) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(`${BUSINESS_SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

    const stkRequest = {
      BusinessShortCode: BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: numericAmount,
      PartyA: phone,
      PartyB: TILL_NUMBER, // Merchant till/shortcode where payment is received
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL, // Must be publicly reachable by Safaricom
      AccountReference: 'PeronTipsFlier',
      TransactionDesc: 'Payment for Peron Tips flier'
    };

    // send STK push request
    const darajaResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkRequest,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    const checkoutId = darajaResponse.data.CheckoutRequestID;

    logs.push({
      phone,
      amount: numericAmount,
      status: 'Pending',
      timestamp,
      checkoutId,
      details: darajaResponse.data
    });

    return res.json({
      message: 'STK push initiated',
      checkoutId,
      raw: darajaResponse.data
    });
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    const status = (error.response && error.response.status) || 500;
    const data = (error.response && error.response.data) || { message: error.message };
    return res.status(status).json({ error: 'Payment initiation failed', details: data });
  }
});

/**
 * GET /status?phone=...
 * Returns last transaction(s) for phone
 */
app.get('/status', (req, res) => {
  const phoneQuery = req.query.phone;
  if (!phoneQuery) return res.status(400).json({ error: 'Phone is required' });

  const normalized = normalizePhone(String(phoneQuery));
  if (!normalized) return res.status(400).json({ error: 'Invalid phone format' });

  const userLogs = logs.filter(log => log.phone === normalized);
  if (userLogs.length === 0) {
    return res.status(404).json({ error: 'No transactions found for this phone' });
  }

  const lastLog = userLogs[userLogs.length - 1];
  return res.json(lastLog);
});

/**
 * POST /callback
 * Safaricom will post stkCallback here. Update logs accordingly.
 */
app.post('/callback', (req, res) => {
  try {
    console.log('Callback received:', JSON.stringify(req.body, null, 2));
    const callback = req.body.Body?.stkCallback;
    if (!callback) {
      console.warn('Invalid callback payload', req.body);
      return res.status(400).json({ error: 'Invalid callback payload' });
    }

    const checkoutId = callback.CheckoutRequestID;
    const items = callback.CallbackMetadata?.Item || [];
    const receiptItem = items.find(i => i.Name === 'MpesaReceiptNumber');
    const amountItem = items.find(i => i.Name === 'Amount');
    const mpesaReceipt = receiptItem?.Value || null;
    const paidAmount = amountItem?.Value || null;

    const logIndex = logs.findIndex(l => l.checkoutId === checkoutId);
    if (logIndex !== -1) {
      logs[logIndex].status = (callback.ResultCode === 0) ? 'Success' : 'Failed';
      logs[logIndex].mpesaReceipt = mpesaReceipt;
      logs[logIndex].resultDesc = callback.ResultDesc;
      if (paidAmount) logs[logIndex].paidAmount = paidAmount;
    } else {
      // If we don't find a matching checkoutId, still persist the callback for inspection
      logs.push({
        phone: 'unknown',
        amount: paidAmount || null,
        status: callback.ResultDesc || 'Unknown',
        timestamp: getTimestamp(),
        checkoutId,
        details: callback,
        mpesaReceipt
      });
    }

    // Respond quickly to Safaricom
    res.json({ ResultCode: 0, ResultDesc: 'Received' });
  } catch (err) {
    console.error('Callback processing error:', err);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

/**
 * GET /logs
 * Optional query param: ?phone=...
 */
app.get('/logs', (req, res) => {
  const phone = req.query.phone;
  const result = phone ? logs.filter(l => l.phone === normalizePhone(String(phone))) : logs;
  res.json(result);
});

// Start server
const port = PORT || 5000;
app.listen(port, () => {
  console.log(`Peron Tips backend running on port ${port}`);
});
