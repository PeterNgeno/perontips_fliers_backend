// Modified server.js — fixed price Ksh 20, new endpoints for frontend
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// Allow the frontend URL you specified
app.use(cors({
  origin: 'https://perontips-fliers.vercel.app',
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
        headers: { Authorization: `Basic ${auth}` }
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

// ------------------ New endpoint expected by frontend ------------------
// POST /api/mpesa/stk
// Body: { phone, event, template }
// Always uses fixed amount = 20 (Ksh)
app.post('/api/mpesa/stk', async (req, res) => {
  try {
    const { phone, event, template } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const FIXED_AMOUNT = 20; // Ksh 20 fixed price

    const token = await getAccessToken();
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
      CallBackURL: CALLBACK_URL, // your callback URL that Safaricom will call
      AccountReference: `PeronTips-${event || 'download'}`,
      TransactionDesc: `PeronTips download (${event || 'custom'})`
    };

    const darajaResponse = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkRequest,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // store log entry with CheckoutRequestID
    const checkoutId = darajaResponse.data.CheckoutRequestID || null;
    const logEntry = {
      phone,
      amount: FIXED_AMOUNT,
      event: event || null,
      template: template || null,
      status: 'Pending',
      timestamp,
      checkoutId,
      details: darajaResponse.data
    };
    logs.push(logEntry);

    // return checkoutId and data to frontend
    return res.json({ checkoutId, data: darajaResponse.data });
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    // send friendly message to frontend
    return res.status(500).json({ error: 'Payment initiation failed', message: error.response?.data || error.message });
  }
});

// ------------------ Status endpoint expected by frontend ------------------
// GET /api/mpesa/status?checkoutId=...
