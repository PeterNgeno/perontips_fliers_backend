const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use(cors({
  origin: 'https://www.perontips.co.ke',
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
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', message: error.message });
  }
});

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
    logs[logIndex].mpesaReceipt = receiptItem?.Value;
    logs[logIndex].resultDesc = callback.ResultDesc;
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

app.get('/logs', (req, res) => {
  const phone = req.query.phone;
  const result = phone ? logs.filter(l => l.phone === phone) : logs;
  res.json(result);
});

const port = PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
