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
  
  // Helper to validate and resolve image URL
  const getValidUrl = (urlStr) => {
    if (!urlStr) return "";
    try {
      let cleanedUrl = urlStr.trim();
      // Fix Shopify theme template issues where protocol-relative URLs miss the "//"
      if (cleanedUrl.startsWith('http:') && !cleanedUrl.startsWith('http://')) {
        cleanedUrl = 'http://' + baseUrl.split('/')[2] + '/' + cleanedUrl.substring(5);
      } else if (cleanedUrl.startsWith('https:') && !cleanedUrl.startsWith('https://')) {
        cleanedUrl = 'https://' + baseUrl.split('/')[2] + '/' + cleanedUrl.substring(6);
      } else if (cleanedUrl.startsWith('//')) {
        cleanedUrl = 'https:' + cleanedUrl;
      }
      
      let resolved = new URL(cleanedUrl, baseUrl).href;
      const parsed = new URL(resolved);
      if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
        return "";
      }
      return resolved;
    } catch (e) {
      return "";
    }
  };

  let image = getValidUrl(ogImage) || getValidUrl(twitterImage) || "";

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
        const validated = getValidUrl(attrs.href);
        if (validated) {
          image = validated;
          break;
        }
      }
    }
  }

  if (!image) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : html;
    const imgMatches = bodyContent.match(/<img\s+[^>]*src=["']([^"']+)["']/gi) || [];
    for (const imgTag of imgMatches) {
      const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
      if (srcMatch) {
        const validated = getValidUrl(srcMatch[1]);
        if (validated) {
          const lower = validated.toLowerCase();
          // Avoid tiny icons, logos, trackers, SVGs
          if (!lower.includes('favicon') && !lower.includes('logo') && !lower.includes('icon') && !lower.includes('svg') && !lower.includes('pixel') && !lower.includes('loader')) {
            image = validated;
            break;
          }
        }
      }
    }
  }

  // Fallback to Thum.io screenshot API if no valid main content image was found
  if (!image) {
    image = `https://image.thum.io/get/width/600/crop/800/maxAge/24/${baseUrl}`;
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
