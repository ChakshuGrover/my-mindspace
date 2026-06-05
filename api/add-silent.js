const https = require('https');
const { URL } = require('url');

const DEFAULT_CLIENT_ID = '345073896444-jvm03jjn5dn6pfh95d7jbtlh4shq4ooj.apps.googleusercontent.com';

function cleanAndParseJSON(rawText) {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    
    let startIdx = -1;
    let endIdx = -1;
    
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIdx = firstBrace;
      endIdx = cleaned.lastIndexOf('}');
    } else if (firstBracket !== -1) {
      startIdx = firstBracket;
      endIdx = cleaned.lastIndexOf(']');
    }
    
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      try {
        const jsonSub = cleaned.substring(startIdx, endIdx + 1);
        return JSON.parse(jsonSub);
      } catch (err) {}
    }
    throw e;
  }
}

function mockAnalysis(inputText) {
  let type = 'note';
  let title = 'Saved Note';
  let summary = 'Saved Note';
  let tags = ['inbox'];
  let vibe = 'minimalist';
  let rawText = inputText;

  if (inputText.startsWith('http://') || inputText.startsWith('https://') || inputText.startsWith('www.')) {
    type = 'article';
    title = inputText.split('/')[2] || 'Web Link';
    summary = `Saved bookmark for ${inputText}`;
    tags = ['link', 'web', 'to-read'];
  } else if (inputText.startsWith('#') && (inputText.length === 4 || inputText.length === 7)) {
    type = 'color';
    title = 'Color Swatch';
    summary = `Hex color code: ${inputText}`;
    tags = ['color', 'design', 'pallet'];
    rawText = inputText;
  } else if (inputText.includes('"') || inputText.includes('“') || inputText.length > 80 && inputText.includes('-')) {
    type = 'quote';
    title = 'Inspirational Quote';
    summary = 'Saved quote from your notes.';
    tags = ['quotes', 'wisdom'];
  }

  return {
    type,
    title,
    ai_analysis: {
      summary,
      tags,
      vibe,
      key_takeaways: []
    },
    content: {
      raw_text: rawText
    }
  };
}

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

  // Parse body stream
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

  const { url, text, is_todo, refresh_token } = parsedBody;

  if (!refresh_token) {
    res.status(400).json({ error: 'Missing refresh_token parameter' });
    return;
  }

  const rawInputText = (url || text || '').trim();
  if (!rawInputText) {
    res.status(400).json({ error: 'Missing content (url or text)' });
    return;
  }

  try {
    // 1. Exchange refresh_token for access_token
    const client_id = process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
    const client_secret = process.env.GOOGLE_CLIENT_SECRET;

    if (!client_secret) {
      res.status(500).json({ error: 'Server configuration error: GOOGLE_CLIENT_SECRET is missing.' });
      return;
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token,
        client_id,
        client_secret,
        grant_type: 'refresh_token'
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      res.status(401).json({ error: 'Failed to refresh Google OAuth token', details: errText });
      return;
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // 2. Scraping URL if present
    const isUrl = !!url;
    let scrapedTitle = null;
    let scrapedImage = null;
    let aiInputText = rawInputText;

    if (isUrl) {
      try {
        const host = req.headers.host || 'localhost:3000';
        const protocol = host.startsWith('localhost') ? 'http' : 'https';
        const scrapeRes = await fetch(`${protocol}://${host}/api/scrape?url=${encodeURIComponent(url)}`);
        if (scrapeRes.ok) {
          const meta = await scrapeRes.json();
          scrapedImage = meta.image;
          scrapedTitle = meta.title;
          aiInputText = `Webpage URL: ${url}\nTitle: ${meta.title}\nDescription: ${meta.description}`;
        }
      } catch (e) {
        console.error('Webhook scraper failed:', e);
      }
    }

    // 3. Query Gemini / Gemma proxy on same host
    let aiParsed = null;
    try {
      const host = req.headers.host || 'localhost:3000';
      const protocol = host.startsWith('localhost') ? 'http' : 'https';
      
      const systemInstruction = `
        You are a premium, highly smart AI engine running inside the "MyMindSpace" personal knowledge-base app.
        Analyze the user input and categorize it into exactly one of these types: "quote", "color", "article", or "note".
        
        CRITICAL: Keep your internal thinking/reasoning process extremely brief (limit to at most 1-2 sentences) to ensure ultra-fast generation.
        
        Rules for categorization:
        1. If the input starts with '#' or is a valid CSS color string (e.g. hex #ffffff, rgb, hsl, or standard color names like 'soft peach'), set type to "color".
        2. If the input looks like a web link / URL (starts with http, https, or www), set type to "article".
        3. If the input looks like a famous quotation or something spoken (contains quotes or represents a powerful proverb/thought), set type to "quote".
        4. Otherwise, categorize as "note".

        Respond STRICTLY in a JSON object with the following fields:
        {
          "type": "quote" | "color" | "article" | "note",
          "title": "A short, beautiful, conceptual title for the card",
          "ai_analysis": {
            "summary": "A concise 1-2 sentence overview/abstract of the item. For quotes, write a beautiful reflection or insight. For colors, describe the feeling/mood of the color.",
            "detailed_summary": "A detailed, comprehensive summary paragraph (3-6 sentences) highlighting the core concepts, key details, and main context of the item. For quotes, write a rich reflection. For colors, write an evocative description.",
            "tags": ["8 to 15 relevant tags representing categories, topics, entities, or related concepts to index this item for semantic search. Do not use hashtags, just simple lowercase words"],
            "vibe": "1-3 descriptive words of the aesthetic/feeling (e.g., 'calm, retro', 'futuristic, clean')",
            "key_takeaways": ["1-3 bulleted key takeaways, steps, recipes, or points. Leave empty for colors."]
          },
          "content": {
            "raw_text": "Clean parsed text of the note or quote. For links, write the page summary. For colors, the color hex code."
          }
        }
      `;

      const payload = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemInstruction}\n\nUSER INPUT:\n${aiInputText}` }]
          }
        ]
      };

      const geminiRes = await fetch(`${protocol}://${host}/api/gemini?model=gemma-4-31b-it`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (geminiRes.ok) {
        const responseData = await geminiRes.json();
        const parts = responseData.candidates?.[0]?.content?.parts || [];
        const textPart = parts.find(p => !p.thought) || parts[0] || { text: '' };
        const rawText = textPart.text || '';
        aiParsed = cleanAndParseJSON(rawText);
      }
    } catch (e) {
      console.error('Webhook Gemini analysis failed:', e);
    }

    if (!aiParsed) {
      aiParsed = mockAnalysis(rawInputText);
    }

    // 4. Construct metadata object
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      created_at: new Date().toISOString(),
      type: is_todo ? 'todo' : ((aiParsed.type === 'note' && isUrl) ? 'article' : aiParsed.type),
      title: is_todo ? (rawInputText.split('\n')[0].trim().substring(0, 40) || 'To-Do List') : (aiParsed.title || scrapedTitle || 'Saved Item'),
      folders: [],
      url: (!is_todo && (aiParsed.type === 'article' || isUrl)) ? (url || rawInputText) : '',
      image: scrapedImage || '',
      ai_analysis: aiParsed.ai_analysis || {
        summary: 'Saved note.',
        tags: ['inbox'],
        vibe: 'clean',
        key_takeaways: []
      },
      content: {
        raw_text: is_todo ? rawInputText : (aiParsed.content?.raw_text || rawInputText),
        word_count: rawInputText.split(/\s+/).length,
        reading_time_mins: Math.max(1, Math.ceil(rawInputText.split(/\s+/).length / 200))
      }
    };

    if (is_todo) {
      const lines = rawInputText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      newItem.content.todos = lines.map(line => ({
        text: line,
        completed: false
      }));
      newItem.ai_analysis.summary = 'To-Do Checklist';
      newItem.ai_analysis.tags = newItem.ai_analysis.tags || [];
      if (!newItem.ai_analysis.tags.includes('todo')) {
        newItem.ai_analysis.tags.push('todo');
      }
    }

    if (newItem.type === 'color' || newItem.type === 'quote') {
      newItem.type = 'note';
    }

    // 5. Create file on Google Drive
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${newItem.id}.json`,
        mimeType: 'application/json',
        parents: ['appDataFolder']
      })
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create file on Google Drive: ${createRes.status}`);
    }

    const driveFile = await createRes.json();
    if (!driveFile.id) {
      throw new Error('Google Drive file creation did not return an ID');
    }

    // 6. Upload file content
    const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveFile.id}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(newItem)
    });

    if (!uploadRes.ok) {
      throw new Error(`Failed to upload file content to Google Drive: ${uploadRes.status}`);
    }

    res.status(200).json({ success: true, item: newItem });
  } catch (err) {
    console.error('Webhook add silent failed:', err);
    res.status(500).json({ error: err.message });
  }
};
