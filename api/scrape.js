const https = require('https');
const http = require('http');
const { URL } = require('url');

function parseHtmlMetadata(html, baseUrl) {
  const metaTags = html.match(/<meta\s+([^>]+)>/gi) || [];
  
  let ogTitle = "";
  let ogDesc = "";
  let ogImage = "";
  let twitterImage = "";
  let descVal = "";
  
  metaTags.forEach(tag => {
    const attrs = {};
    const attrRegex = /([a-z0-9:-]+)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/gi;
    let match;
    while ((match = attrRegex.exec(tag)) !== null) {
      const key = match[1].toLowerCase();
      const val = match[2] || match[3] || "";
      attrs[key] = val;
    }
    
    const prop = (attrs.property || "").toLowerCase();
    const name = (attrs.name || "").toLowerCase();
    const val = attrs.content || "";
    
    if (prop === 'og:title') ogTitle = val;
    else if (prop === 'og:description') ogDesc = val;
    else if (prop === 'og:image') ogImage = val;
    else if (name === 'twitter:image') twitterImage = val;
    else if (name === 'description') descVal = val;
  });

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let titleTag = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : "";
  
  const title = ogTitle || titleTag || baseUrl.split('/').pop() || baseUrl;
  const description = ogDesc || descVal || "";
  let image = ogImage || twitterImage || "";

  if (!image) {
    const linkTags = html.match(/<link\s+([^>]+)>/gi) || [];
    for (const tag of linkTags) {
      const attrs = {};
      const attrRegex = /([a-z0-9:-]+)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/gi;
      let match;
      while ((match = attrRegex.exec(tag)) !== null) {
        attrs[match[1].toLowerCase()] = match[2] || match[3] || "";
      }
      if ((attrs.rel || "").toLowerCase() === 'image_src' && attrs.href) {
        image = attrs.href;
        break;
      }
    }
  }

  if (!image) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : html;
    const imgMatch = bodyContent.match(/<img\s+[^>]*src=["']([^"']+)["']/i);
    if (imgMatch) {
      image = imgMatch[1];
    }
  }

  if (image) {
    try {
      image = new URL(image, baseUrl).href;
    } catch (e) {
      // Ignore URL parsing errors
    }
  }

  const unescapeHtml = (str) => {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'");
  };

  return {
    title: unescapeHtml(title).trim(),
    description: unescapeHtml(description).trim(),
    image: image.trim()
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { url: targetUrl } = req.query;
  if (!targetUrl) {
    res.status(400).json({ error: 'Missing URL parameter' });
    return;
  }

  try {
    const client = targetUrl.startsWith('https') ? https : http;
    
    const requestOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 8000
    };

    client.get(targetUrl, requestOptions, (scrapeRes) => {
      const contentType = scrapeRes.headers['content-type'] || '';
      
      if (!contentType.includes('text/html')) {
        res.status(200).json({
          title: targetUrl.split('/').pop() || targetUrl,
          description: '',
          image: ''
        });
        return;
      }

      let data = '';
      scrapeRes.on('data', (chunk) => data += chunk);
      scrapeRes.on('end', () => {
        const metadata = parseHtmlMetadata(data, targetUrl);
        res.status(200).json(metadata);
      });
    }).on('error', (err) => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
