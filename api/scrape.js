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
  const candidateImages = [];

  // Helper to add a candidate
  const addCandidate = (src, baseScore, sourceTag = {}) => {
    if (!src) return;
    let resolved = src.trim();
    try {
      // Fix relative/protocol-relative slashes
      if (resolved.startsWith('//')) {
        resolved = 'https:' + resolved;
      } else if (resolved.startsWith('/')) {
        resolved = new URL(resolved, baseUrl).href;
      } else if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
        resolved = new URL(resolved, baseUrl).href;
      }
      
      const parsedUrl = new URL(resolved);
      if (!parsedUrl.hostname.includes('.') && parsedUrl.hostname !== 'localhost') {
        return;
      }
      
      candidateImages.push({
        url: resolved,
        baseScore,
        attrs: sourceTag
      });
    } catch (e) {}
  };

  // 1. Add OG / Twitter images
  addCandidate(ogImage, 100);
  addCandidate(twitterImage, 100);

  // 2. Add link rel="image_src"
  const linkTags = html.match(/<link\s+([^>]+)>/gi) || [];
  for (const tag of linkTags) {
    const attrs = {};
    const attrRegex = /([a-z0-9:-]+)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/gi;
    let match;
    while ((match = attrRegex.exec(tag)) !== null) {
      attrs[match[1].toLowerCase()] = match[2] || match[3] || "";
    }
    if ((attrs.rel || "").toLowerCase() === 'image_src' && attrs.href) {
      addCandidate(attrs.href, 80);
    }
  }

  // 3. Add body images
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : html;
  const imgTags = bodyContent.match(/<img\s+[^>]+>/gi) || [];
  imgTags.forEach(tag => {
    const attrs = {};
    const attrRegex = /([a-z0-9:-]+)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/gi;
    let match;
    while ((match = attrRegex.exec(tag)) !== null) {
      attrs[match[1].toLowerCase()] = match[2] || match[3] || "";
    }
    if (attrs.src) {
      addCandidate(attrs.src, 50, attrs);
    }
  });

  // Keywords for scoring
  const keywords = [];
  if (title) {
    title.toLowerCase().split(/[^a-z0-9]+/i).forEach(w => {
      if (w.length >= 3) keywords.push(w);
    });
  }
  try {
    const parsed = new URL(baseUrl);
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
  } catch (e) {}

  // Score candidates
  const scoredCandidates = [];
  candidateImages.forEach(candidate => {
    const lower = candidate.url.toLowerCase();
    
    // Tracking pixels / spacers / generic placeholders are rejected immediately
    if (lower.includes('pixel') || lower.includes('loader') || lower.includes('spacer') || lower.includes('no-image') || lower.includes('placeholder')) {
      return;
    }

    // Check size attributes
    let width = parseInt(candidate.attrs.width, 10);
    let height = parseInt(candidate.attrs.height, 10);
    
    try {
      const parsedUrl = new URL(candidate.url);
      const wQuery = parseInt(parsedUrl.searchParams.get('width') || parsedUrl.searchParams.get('w'), 10);
      const hQuery = parseInt(parsedUrl.searchParams.get('height') || parsedUrl.searchParams.get('h'), 10);
      if (!isNaN(wQuery)) width = wQuery;
      if (!isNaN(hQuery)) height = hQuery;
    } catch (e) {}

    const shopifySizeMatch = candidate.url.match(/_(\d+)x/);
    if (shopifySizeMatch) {
      const sizeVal = parseInt(shopifySizeMatch[1], 10);
      width = sizeVal;
      height = sizeVal;
    }

    // Explicit dimensions filter
    if ((!isNaN(width) && width < 200) || (!isNaN(height) && height < 200)) {
      return;
    }

    const checkStr = `${candidate.attrs.alt || ''} ${candidate.attrs.class || ''} ${candidate.attrs.id || ''} ${candidate.attrs['aria-label'] || ''} ${lower}`.toLowerCase();
    
    // Explicit logo/icon indicators (icons are small graphics, SVGs are vector shapes)
    if (checkStr.includes('favicon') || checkStr.includes('avatar') || checkStr.includes('icon') || checkStr.includes('loader') || lower.endsWith('.svg')) {
      return;
    }

    let score = candidate.baseScore;

    // Soft penalty for logos/brands
    if (checkStr.includes('logo') || checkStr.includes('brand')) {
      score -= 20;
    }

    // Path keyword bonuses
    keywords.forEach(word => {
      if (checkStr.includes(word)) {
        score += 30;
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

    scoredCandidates.push({ url: candidate.url, score });
  });

  let image = "";
  if (scoredCandidates.length > 0) {
    scoredCandidates.sort((a, b) => b.score - a.score);
    if (scoredCandidates[0].score >= 30) {
      image = scoredCandidates[0].url;
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

  const extractCleanText = (htmlContent) => {
    if (!htmlContent) return '';
    // Strip tags with their inner content
    let text = htmlContent.replace(/<(script|style|nav|header|footer|head|noscript|iframe|select|option)[^>]*>([\s\S]*?)<\/\1>/gi, '');
    // Strip all other HTML tags
    text = text.replace(/<[^>]+>/g, ' ');
    // Decode basic HTML entities
    text = text.replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"')
               .replace(/&#039;/g, "'")
               .replace(/&nbsp;/g, ' ')
               .replace(/&mdash;/g, '—')
               .replace(/&ndash;/g, '–');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    // Truncate if too long to prevent Vercel/Google Drive payload issues
    if (text.length > 60000) {
      text = text.substring(0, 60000) + '... [Content Truncated]';
    }
    return text;
  };

  return {
    title: unescapeHtml(title).trim(),
    description: unescapeHtml(description).trim(),
    image: image.trim(),
    fullText: extractCleanText(html)
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
          image: '',
          fullText: ''
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
