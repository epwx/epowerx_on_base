// Usage: node test-biconomy-openorders.js
// Fill in your API key, secret, and market below

const axios = require('axios');
const crypto = require('crypto');

const API_KEY = 'YOUR_API_KEY'; // <-- Replace with your API key
const API_SECRET = 'YOUR_API_SECRET'; // <-- Replace with your API secret
const MARKET = 'EPWX_USDT'; // <-- Replace with your market symbol
const BASE_URL = 'https://api.biconomy.com';

function generateSignature(params, secret) {
  // Sort params alphabetically
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  const stringToSign = `${paramString}&secret_key=${secret}`;
  return crypto.createHash('md5').update(stringToSign).digest('hex').toUpperCase();
}

async function testGetOpenOrders() {
  const params = {
    api_key: API_KEY,
    market: MARKET,
    offset: 0,
    limit: 10,
  };
  params.sign = generateSignature(params, API_SECRET);

  const headers = {
    'X-API-KEY': API_KEY,
    'X-SITE-ID': '127',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const urlParams = new URLSearchParams(params);

  try {
    const response = await axios.post(
      `${BASE_URL}/api/v1/private/order/pending`,
      urlParams.toString(),
      { headers }
    );
    console.log('Status:', response.status);
    console.log('Response:', response.data);
  } catch (error) {
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
  }
}

testGetOpenOrders();
