const https = require('https');

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { model, key, stream } = req.query;
  const geminiKey = (key && key.trim() !== '') ? key : process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    res.status(400).json({ error: 'Missing Gemini API Key' });
    return;
  }

  const modelName = model || 'gemma-4-31b-it';
  let action = 'generateContent';
  if (modelName.includes('embedding')) {
    action = 'embedContent';
  } else if (stream === 'true') {
    action = 'streamGenerateContent';
  }

  const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${action}?key=${geminiKey}`;

  try {
    // Vercel parses JSON bodies automatically into req.body
    const postData = JSON.stringify(req.body);

    const forwardReq = https.request(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    }, (googleRes) => {
      res.status(googleRes.statusCode);
      res.setHeader('Content-Type', googleRes.headers['content-type'] || 'application/json');
      
      if (stream === 'true') {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        googleRes.on('data', (chunk) => {
          res.write(chunk);
        });
        googleRes.on('end', () => {
          res.end();
        });
      } else {
        let body = '';
        googleRes.on('data', (chunk) => body += chunk);
        googleRes.on('end', () => {
          res.send(body);
        });
      }
    });

    forwardReq.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });

    forwardReq.write(postData);
    forwardReq.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
