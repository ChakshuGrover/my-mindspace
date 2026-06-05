module.exports = async (req, res) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
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

  res.status(200).json({ refresh_token });
};
