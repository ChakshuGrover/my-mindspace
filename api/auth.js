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

  // Parse body
  let body = '';
  await new Promise((resolve) => {
    req.on('data', chunk => body += chunk);
    req.on('end', resolve);
  });

  let parsedBody = {};
  try {
    parsedBody = JSON.parse(body);
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const { code, redirect_uri } = parsedBody;
  if (!code || !redirect_uri) {
    res.status(400).json({ error: 'Missing code or redirect_uri' });
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
    code,
    client_id,
    client_secret,
    redirect_uri,
    grant_type: 'authorization_code'
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
    if (googleRes.statusCode !== 200) {
      res.status(googleRes.statusCode).json(parsedData);
      return;
    }

    if (parsedData.refresh_token) {
      res.setHeader('Set-Cookie', `mymind_refresh_token=${parsedData.refresh_token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`);
      delete parsedData.refresh_token;
    }

    res.status(200).json(parsedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
