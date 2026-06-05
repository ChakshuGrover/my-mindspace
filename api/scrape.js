const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchHtmlContent(urlStr, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr);
      const client = parsed.protocol === 'https:' ? https : http;
      
      const req = client.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirUrl = new URL(res.headers.location, urlStr).href;
          resolve(fetchHtmlContent(redirUrl, timeoutMs));
          return;
        }
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function fetchHomepageImage(baseUrl, title) {
  try {
    const parsed = new URL(baseUrl);
    const hostParts = parsed.hostname.split('.');
    const domain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : parsed.hostname;
    
    const keywords = [];
    if (title) {
      title.toLowerCase().split(/[^a-z0-9]+/i).forEach(w => {
        if (w.length >= 3) keywords.push(w);
      });
    }
    const sub = parsed.hostname.split('.')[0];
    if (sub && sub !== 'www' && sub.length >= 2) {
      keywords.push(sub.toLowerCase());
    }
    parsed.pathname.split(/[^a-z0-9]+/i).forEach(w => {
      const lower = w.toLowerCase();
      if (lower.length >= 3 && !['learn', 'home', 'section', 'lesson', 'course'].includes(lower)) {
        keywords.push(lower);
      }
    });

    const urlsToTry = [
      `https://www.${domain}/`,
      `https://${domain}/`,
      `https://${parsed.hostname}/`
    ];

    const uniqueUrls = Array.from(new Set(urlsToTry));

    for (const homeUrl of uniqueUrls) {
      try {
        const html = await fetchHtmlContent(homeUrl, 3000);
        if (!html) continue;

        const imgMatches = html.match(/<img[^>]*src=["']([^"']+)["']/gi) || [];
        if (imgMatches.length === 0) continue;

        const scoredImages = [];
        imgMatches.forEach(tag => {
          const srcMatch = tag.match(/src=["']([^"']+)["']/i);
          if (!srcMatch) return;
          const src = srcMatch[1];
          
          let resolved = src.trim();
          if (resolved.startsWith('//')) {
            resolved = 'https:' + resolved;
          } else if (resolved.startsWith('/')) {
            resolved = new URL(resolved, homeUrl).href;
          } else if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
            resolved = new URL(resolved, homeUrl).href;
          }

          const lower = resolved.toLowerCase();
          if (lower.includes('pixel') || lower.includes('loader') || lower.includes('spacer') || lower.includes('no-image') || lower.includes('placeholder')) {
            return;
          }

          let score = 0;
          keywords.forEach(word => {
            if (lower.includes(word)) {
              score += 50;
            }
          });

          if (lower.includes('banner') || lower.includes('hero') || lower.includes('cover')) {
            score += 30;
          }
          if (lower.includes('desktop') || lower.includes('-web') || lower.includes('_web')) {
            score += 20;
          }
          if (lower.includes('mobile') || lower.includes('-thumb') || lower.includes('_thumb')) {
            score -= 15;
          }
          if (lower.includes('logo') || lower.includes('brand')) {
            score += 15;
          }
          if (lower.endsWith('.svg')) {
            score += 10;
          }

          scoredImages.push({ url: resolved, score });
        });

        if (scoredImages.length > 0) {
          scoredImages.sort((a, b) => b.score - a.score);
          if (scoredImages[0].score >= 40) {
            return scoredImages[0].url;
          }
        }
      } catch (err) {
        // Continue
      }
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

async function parseHtmlMetadata(html, baseUrl) {
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
      
      // Fix protocol-relative double slashes
      if (cleanedUrl.startsWith('//')) {
        cleanedUrl = 'https:' + cleanedUrl;
      }
      
      // Check for missing double slashes (e.g., "http:products/img.jpg" or "https:cdn.shopify.com/...")
      if (cleanedUrl.startsWith('http:') && !cleanedUrl.startsWith('http://')) {
        const rest = cleanedUrl.substring(5);
        if (rest.startsWith('/')) {
          cleanedUrl = 'http:/' + rest;
        } else {
          // Malformed relative URL like "http:products/img.jpg"
          return "";
        }
      } else if (cleanedUrl.startsWith('https:') && !cleanedUrl.startsWith('https://')) {
        const rest = cleanedUrl.substring(6);
        if (rest.startsWith('/')) {
          cleanedUrl = 'https:/' + rest;
        } else {
          // Malformed relative URL like "https:products/img.jpg"
          return "";
        }
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

  const isTinyOrIcon = (urlStr) => {
    if (!urlStr) return true;
    try {
      const parsed = new URL(urlStr);
      const width = parseInt(parsed.searchParams.get('width') || parsed.searchParams.get('w'), 10);
      const height = parseInt(parsed.searchParams.get('height') || parsed.searchParams.get('h'), 10);
      if ((!isNaN(width) && width < 200) || (!isNaN(height) && height < 200)) {
        return true;
      }
      
      // Check for Shopify filename suffix thumbnail size (e.g. "_20x", "_100x")
      const shopifySizeMatch = urlStr.match(/_(\d+)x/);
      if (shopifySizeMatch) {
        const sizeVal = parseInt(shopifySizeMatch[1], 10);
        if (sizeVal < 200) {
          return true;
        }
      }
      
      const lower = urlStr.toLowerCase();
      if (lower.includes('favicon') || lower.includes('logo') || lower.includes('icon') || lower.includes('svg') || lower.includes('pixel') || lower.includes('loader') || lower.includes('no-image')) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  };

  let image = getValidUrl(ogImage) || getValidUrl(twitterImage) || "";
  if (image && isTinyOrIcon(image)) {
    image = "";
  }

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
        if (validated && !isTinyOrIcon(validated)) {
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
        if (validated && !isTinyOrIcon(validated)) {
          image = validated;
          break;
        }
      }
    }
  }

  // Fallback to homepage smart logo/banner or brand favicon if no valid main content image was found
  if (!image) {
    try {
      const homeImg = await fetchHomepageImage(baseUrl, title);
      if (homeImg) {
        image = homeImg;
      } else {
        const parsed = new URL(baseUrl);
        const hostParts = parsed.hostname.split('.');
        const domain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : parsed.hostname;
        image = `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=256`;
      }
    } catch (e) {
      image = `https://image.thum.io/get/width/600/crop/800/maxAge/24/${baseUrl}`;
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
      scrapeRes.on('end', async () => {
        const metadata = await parseHtmlMetadata(data, targetUrl);
        res.status(200).json(metadata);
      });
    }).on('error', (err) => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
