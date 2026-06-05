const https = require('https');
const { URL } = require('url');

module.exports = async (req, res) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Read refresh token from cookies
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/mymind_refresh_token=([^;]+)/);
  const refresh_token = match ? match[1] : null;

  if (!refresh_token) {
    res.status(401).json({ error: 'No refresh token found. Re-authentication required.' });
    return;
  }

  const client_id = process.env.GOOGLE_CLIENT_ID || '345073896444-jvm03jjn5dn6pfh95d7jbtlh4shq4ooj.apps.googleusercontent.com';
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;

  if (!client_secret) {
    res.status(500).json({ error: 'Server configuration error: GOOGLE_CLIENT_SECRET is missing.' });
    return;
  }

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const postData = JSON.stringify({
    refresh_token,
    client_id,
    client_secret,
    grant_type: 'refresh_token'
  });

  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 8000
  };

  try {
    const googleRes = await new Promise((resolve, reject) => {
      const gReq = https.request(tokenUrl, requestOptions, (gRes) => {
        let gData = '';
        gRes.on('data', chunk => gData += chunk);
        gRes.on('end', () => {
          resolve({ statusCode: gRes.statusCode, data: gData });
        });
      });
      gReq.on('error', reject);
      gReq.write(postData);
      gReq.end();
    });

    const parsedData = JSON.parse(googleRes.data);
    res.status(googleRes.statusCode).json(parsedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
