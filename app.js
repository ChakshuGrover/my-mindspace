// --- Safe localStorage Polyfill for file:// Protocol ---
let safeStorage;
try {
  window.localStorage.setItem('__mymind_test_ls', '1');
  window.localStorage.removeItem('__mymind_test_ls');
  safeStorage = window.localStorage;
} catch (e) {
  console.warn('Native localStorage is blocked (common under file:// protocol). Falling back to in-memory storage.');
  safeStorage = {
    _data: {},
    setItem(id, val) { this._data[id] = String(val); },
    getItem(id) { return this._data.hasOwnProperty(id) ? this._data[id] : null; },
    removeItem(id) { delete this._data[id]; },
    clear() { this._data = {}; }
  };
}

// --- Constants & Global State ---
let tokenClient;
let accessToken = null;
let userEmail = null;
let driveFiles = []; // Array of downloaded mind items
let folders = []; // Array of virtual folders
let currentFilter = 'all'; // 'all', 'type-quote', 'folder-ID', etc.
let searchTimeout = null;

// Default credentials for sandbox testing (User can override in settings)
const DEFAULT_CLIENT_ID = '345073896444-jvm03jjn5dn6pfh95d7jbtlh4shq4ooj.apps.googleusercontent.com';

// LocalStorage Keys
const STORAGE_KEYS = {
  CLIENT_ID: 'mymind_client_id',
  GEMINI_KEY: 'mymind_gemini_key',
  AI_MODEL: 'mymind_ai_model',
  ACCESS_TOKEN: 'mymind_access_token'
};

// --- Initializing UI Elements ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function initApp() {
  // Capture pending share parameters immediately on startup
  const urlParams = new URLSearchParams(window.location.search);
  const addUrl = urlParams.get('add');
  if (addUrl) {
    safeStorage.setItem('mymind_pending_add', addUrl);
    // Remove query parameter from address bar immediately to keep URL clean
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Load saved configuration or set defaults
  const savedClientId = safeStorage.getItem(STORAGE_KEYS.CLIENT_ID);
  const isValidClientId = savedClientId && 
                          savedClientId !== '9383626292-sandbox-id.apps.googleusercontent.com' &&
                          savedClientId !== 'undefined' &&
                          savedClientId !== 'null' &&
                          savedClientId.trim() !== '' &&
                          savedClientId.endsWith('.apps.googleusercontent.com');

  if (!isValidClientId) {
    safeStorage.setItem(STORAGE_KEYS.CLIENT_ID, DEFAULT_CLIENT_ID);
    safeStorage.setItem(STORAGE_KEYS.AI_MODEL, 'gemma-4-31b-it');
  }

  // One-time migration to Gemma for existing users who had the old default
  const migrated = safeStorage.getItem('mymind_gemma_migrated');
  if (!migrated) {
    const savedModel = safeStorage.getItem(STORAGE_KEYS.AI_MODEL);
    if (!savedModel || savedModel === 'gemini-3.1-flash-lite') {
      safeStorage.setItem(STORAGE_KEYS.AI_MODEL, 'gemma-4-31b-it');
    }
    safeStorage.setItem('mymind_gemma_migrated', 'true');
  }

  // Load configuration into Settings Form
  document.getElementById('setting-gemini-key').value = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  document.getElementById('setting-model').value = safeStorage.getItem(STORAGE_KEYS.AI_MODEL);

  // Bind Event Listeners
  setupEventListeners();

  // Load Google APIs
  loadGoogleLibraries();

  // Register Service Worker for PWA support
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('Service Worker registered successfully:', reg.scope))
        .catch((err) => console.error('Service Worker registration failed:', err));
    });
  }
}

// --- Library Loaders ---
function loadGoogleLibraries() {
  setSyncStatus('syncing', 'Loading APIs...');
  
  // 4-second fallback timeout to prevent hangs
  const fallbackTimeout = setTimeout(() => {
    console.warn('Google Library load timeout, showing landing page fallback');
    showLandingPage();
    setSyncStatus('synced', 'Offline');
  }, 4000);

  const checkAndInit = () => {
    const isGoogleLoaded = typeof google !== 'undefined' && google.accounts && google.accounts.oauth2;
    
    if (isGoogleLoaded) {
      clearTimeout(fallbackTimeout);
      initGoogleIdentityClient();
    } else {
      // Retry in 100ms
      setTimeout(checkAndInit, 100);
    }
  };

  checkAndInit();
}

function initGoogleIdentityClient() {
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: safeStorage.getItem(STORAGE_KEYS.CLIENT_ID),
      scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
      callback: (tokenResponse) => {
        if (tokenResponse.error !== undefined) {
          console.error('Oauth authorization error:', tokenResponse.error);
          showToast('Failed to connect to Google Drive.');
          return;
        }
        accessToken = tokenResponse.access_token;
        safeStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        verifyAndFetchData();
      }
    });
    console.log('Google Identity Client Initialized');

    // Auto-connect if access token is already saved
    const savedToken = safeStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    if (savedToken) {
      accessToken = savedToken;
      verifyAndFetchData();
    } else {
      showLandingPage();
    }
  } catch (err) {
    console.error('Error initializing Google Identity Services Client:', err);
    showLandingPage();
  }
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Login / Logout Buttons
  document.getElementById('btn-login').addEventListener('click', () => {
    if (tokenClient) {
      tokenClient.requestAccessToken();
    } else {
      showToast('Authentication library loading. Please try again in a moment.');
    }
  });
  
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('btn-mobile-logout').addEventListener('click', logout);
  document.getElementById('btn-refresh').addEventListener('click', refreshData);
  document.getElementById('btn-mobile-refresh').addEventListener('click', refreshData);

  // Modals & Panels open/close
  document.getElementById('btn-settings').addEventListener('click', () => openModal('settings-modal'));
  document.getElementById('btn-mobile-settings').addEventListener('click', () => openModal('settings-modal'));
  const btnLandingSettings = document.getElementById('btn-landing-settings');
  if (btnLandingSettings) {
    btnLandingSettings.addEventListener('click', () => openModal('settings-modal'));
  }
  document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-close-settings-modal').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('settings-modal-backdrop').addEventListener('click', () => closeModal('settings-modal'));

  document.getElementById('btn-quick-add').addEventListener('click', () => openModal('add-modal'));
  document.getElementById('btn-cancel-add').addEventListener('click', () => closeModal('add-modal'));
  document.getElementById('btn-close-add-modal').addEventListener('click', () => closeModal('add-modal'));
  document.getElementById('add-modal-backdrop').addEventListener('click', () => closeModal('add-modal'));

  document.getElementById('btn-new-folder').addEventListener('click', () => openModal('folder-modal'));
  document.getElementById('btn-cancel-folder').addEventListener('click', () => closeModal('folder-modal'));
  document.getElementById('btn-close-folder-modal').addEventListener('click', () => closeModal('folder-modal'));
  document.getElementById('folder-modal-backdrop').addEventListener('click', () => closeModal('folder-modal'));

  document.getElementById('btn-close-detail-modal').addEventListener('click', () => closeModal('detail-modal'));
  document.getElementById('detail-modal-backdrop').addEventListener('click', () => closeModal('detail-modal'));

  // Save actions
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-folder').addEventListener('click', saveNewFolder);
  document.getElementById('btn-save-add').addEventListener('click', saveNewItem);

  // Search filter typing
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      renderGrid();
    }, 150);
  });

  // Hotkey commands (⌘K or Ctrl+K for search, Esc to close modals)
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search-input').focus();
    }
    if (e.key === 'Escape') {
      closeAllModals();
    }
  });

  // Sidebar Views / Filters clicking
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
      e.currentTarget.classList.add('active');
      currentFilter = e.currentTarget.dataset.filter;
      renderGrid();
    });
  });

  // Check clipboard when browser page is focused / re-opened
  window.addEventListener('focus', checkClipboardForUrl);
}

// --- Navigation & Landing UI Switches ---
function showLandingPage() {
  const loader = document.getElementById('loader');
  if (loader) loader.setAttribute('hidden', 'true');
  document.getElementById('landing-page').removeAttribute('hidden');
  document.getElementById('app-page').setAttribute('hidden', 'true');
}

function showAppPage() {
  const loader = document.getElementById('loader');
  if (loader) loader.setAttribute('hidden', 'true');
  document.getElementById('landing-page').setAttribute('hidden', 'true');
  document.getElementById('app-page').removeAttribute('hidden');
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  modal.removeAttribute('hidden');
  
  // Set focus on inputs
  if (modalId === 'add-modal') {
    document.getElementById('add-input').focus();
    populateFolderSelect();
  } else if (modalId === 'folder-modal') {
    document.getElementById('folder-name-input').focus();
  }
}

function closeModal(modalId) {
  document.getElementById(modalId).setAttribute('hidden', 'true');
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.setAttribute('hidden', 'true'));
}

// --- Google Drive API Integration ---
async function verifyAndFetchData() {
  setSyncStatus('syncing', 'Connecting Profile...');
  
  try {
    // 1. Fetch User Profile Info
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!profileRes.ok) {
      if (profileRes.status === 401) {
        logout();
        return;
      }
      throw new Error('Profile fetch failed');
    }
    
    const profile = await profileRes.json();
    userEmail = profile.email || null;
    if (userEmail) {
      safeStorage.setItem('mymind_user_email', userEmail);
    }
    document.getElementById('user-avatar').src = profile.picture || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp';
    document.getElementById('user-name').textContent = profile.name || 'Personal Mind';

    showAppPage();

    // 2. Fetch or Create folders.json File
    await loadFolders();

    // 3. Fetch all Mind Items inside the appDataFolder
    await loadMindItems();

    // 4. Check for query parameters (?add=)
    handleShareQueryParams();

  } catch (err) {
    console.error('Error verifying Google Drive access:', err);
    showToast('Failed to connect to Google Drive. Re-authenticating...');
    logout();
  }
}

async function loadFolders() {
  setSyncStatus('syncing', 'Loading Folders...');
  try {
    // Search folders.json in appDataFolder
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='folders.json' and mimeType='application/json'&fields=files(id, name)`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await res.json();
    
    if (data.files && data.files.length > 0) {
      // folders.json exists, download content
      const fileId = data.files[0].id;
      const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      folders = await contentRes.json();
      safeStorage.setItem('folders_file_id', fileId);
    } else {
      // Create a folders.json file
      console.log('folders.json not found, creating new one...');
      folders = [];
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'folders.json',
          mimeType: 'application/json',
          parents: ['appDataFolder']
        })
      });
      const newFile = await createRes.json();
      safeStorage.setItem('folders_file_id', newFile.id);
      
      // Upload empty list content
      await uploadFileContent(newFile.id, []);
    }
    
    renderSidebarFolders();
  } catch (err) {
    console.error('Failed to load/create folders.json:', err);
  }
}

async function loadMindItems() {
  setSyncStatus('syncing', 'Syncing your Mind...');
  try {
    // List all application/json files inside appDataFolder except folders.json
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name != 'folders.json' and mimeType='application/json' and trashed=false&fields=files(id, name)&pageSize=100`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await res.json();
    
    driveFiles = [];
    
    if (data.files && data.files.length > 0) {
      // Download contents of each JSON file in parallel
      const fetchPromises = data.files.map(async (file) => {
        try {
          const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          const item = await contentRes.json();
          item._drive_file_id = file.id; // Keep tracking the Google Drive File ID
          return item;
        } catch (e) {
          console.error(`Error loading file content for ${file.name}:`, e);
          return null;
        }
      });
      
      const loaded = await Promise.all(fetchPromises);
      driveFiles = loaded.filter(x => x !== null);
      
      // Sort drive files by creation date (newest first)
      driveFiles.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    
    setSyncStatus('synced', 'Synced');
    renderGrid();
    renderSidebarFolders(); // Update counts
  } catch (err) {
    console.error('Failed to load mind items:', err);
    setSyncStatus('synced', 'Offline');
  }
}

async function uploadFileContent(fileId, jsonContent) {
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(jsonContent)
  });
}

// --- Folder Management ---
async function saveNewFolder() {
  const nameInput = document.getElementById('folder-name-input');
  const emojiInput = document.getElementById('folder-emoji-input');
  const colorInput = document.getElementById('folder-color-input');
  
  const name = nameInput.value.trim();
  const emoji = emojiInput.value.trim() || '📁';
  const color = colorInput.value;

  if (!name) {
    showToast('Folder name cannot be empty.');
    return;
  }

  const newFolder = {
    id: 'folder-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
    name: name,
    emoji: emoji,
    color: color,
    created_at: new Date().toISOString()
  };

  folders.push(newFolder);
  
  // Reset inputs
  nameInput.value = '';
  emojiInput.value = '📁';
  
  closeModal('folder-modal');
  setSyncStatus('syncing', 'Saving Folder...');

  try {
    const foldersFileId = safeStorage.getItem('folders_file_id');
    await uploadFileContent(foldersFileId, folders);
    renderSidebarFolders();
    showToast(`Created folder "${name}"`);
    setSyncStatus('synced', 'Synced');
  } catch (err) {
    console.error('Failed to save new folder to Google Drive:', err);
    showToast('Failed to save folder to Google Drive.');
    setSyncStatus('synced', 'Sync Failed');
  }
}

function renderSidebarFolders() {
  const container = document.getElementById('sidebar-folders');
  container.innerHTML = '';

  folders.forEach(folder => {
    // Count items belonging to this folder
    const count = driveFiles.filter(item => item.folders && item.folders.includes(folder.id)).length;
    
    const navItem = document.createElement('button');
    navItem.className = `folder-nav-item ${currentFilter === 'folder-' + folder.id ? 'active' : ''}`;
    navItem.dataset.filter = 'folder-' + folder.id;
    
    navItem.innerHTML = `
      <div class="folder-nav-info">
        <span class="folder-dot" style="background-color: ${folder.color};"></span>
        <span class="folder-emoji">${folder.emoji}</span>
        <span class="folder-name">${folder.name}</span>
      </div>
      <span class="folder-count">${count}</span>
    `;

    navItem.addEventListener('click', (e) => {
      document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
      navItem.classList.add('active');
      currentFilter = navItem.dataset.filter;
      renderGrid();
    });

    container.appendChild(navItem);
  });
}

function populateFolderSelect() {
  const select = document.getElementById('add-folder-select');
  select.innerHTML = '<option value="">No folder (Inbox)</option>';
  
  folders.forEach(folder => {
    const opt = document.createElement('option');
    opt.value = folder.id;
    opt.textContent = `${folder.emoji} ${folder.name}`;
    select.appendChild(opt);
  });
}

// --- AI Analysis Parser (Gemma 4 31B and Gemini 3.1 Flash Lite) ---
async function analyzeInputWithAI(inputText) {
  let apiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  
  // If no API key is set but user is chakshu.grover8@gmail.com, we proceed (Vercel serverless proxy uses environment variable)
  const email = userEmail || safeStorage.getItem('mymind_user_email');
  const isChakshu = email === 'chakshu.grover8@gmail.com';

  if (!apiKey && !isChakshu) {
    // Return mock analysis if no API Key provided
    return mockAnalysis(inputText);
  }

  const model = safeStorage.getItem(STORAGE_KEYS.AI_MODEL) || 'gemma-4-31b-it';
  
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
        "tags": ["3 to 7 relevant tags representing topics, concepts, colors, or moods. Do not use hashtags, just simple lowercase words"],
        "vibe": "1-3 descriptive words of the aesthetic/feeling (e.g., 'calm, retro', 'futuristic, clean')",
        "key_takeaways": ["1-3 bulleted key takeaways, steps, recipes, or points. Leave empty for colors."]
      },
      "content": {
        "raw_text": "Clean parsed text of the note or quote. For links, write the page summary. For colors, the color hex code."
      }
    }
  `;

  try {
    const endpoint = `/api/gemini?model=${model}&key=${apiKey}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemInstruction}\n\nUSER INPUT:\n${inputText}` }]
        }
      ]
    };
    if (!model.includes('gemma')) {
      payload.generationConfig = {
        responseMimeType: 'application/json'
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error('AI Studio request failed');
    
    const responseData = await response.json();
    const parts = responseData.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => !p.thought) || parts[0] || { text: '' };
    const rawText = textPart.text || '';
    const parsedJSON = cleanAndParseJSON(rawText);
    return parsedJSON;
  } catch (err) {
    console.error('Error querying Gemini API:', err);
    showToast('AI analysis failed. Using automatic fallback tagging.');
    return mockAnalysis(inputText);
  }
}

function cleanAndParseJSON(rawText) {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  }
  return JSON.parse(cleaned);
}

// Fallback Mock Local Parser in case API key is missing
function mockAnalysis(inputText) {
  let type = 'note';
  let title = 'Saved Note';
  let summary = 'Saved Note';
  let tags = ['inbox'];
  let vibe = 'minimalist';
  let rawText = inputText;

  // Simple link check
  if (inputText.startsWith('http://') || inputText.startsWith('https://') || inputText.startsWith('www.')) {
    type = 'article';
    title = inputText.split('/')[2] || 'Web Link';
    summary = `Saved bookmark for ${inputText}`;
    tags = ['link', 'web', 'to-read'];
  }
  // Simple color check
  else if (inputText.startsWith('#') && (inputText.length === 4 || inputText.length === 7)) {
    type = 'color';
    title = 'Color Swatch';
    summary = `Hex color code: ${inputText}`;
    tags = ['color', 'design', 'pallet'];
    rawText = inputText;
  }
  // Simple Quote check
  else if (inputText.includes('"') || inputText.includes('“') || inputText.length > 80 && inputText.includes('-')) {
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

// --- Item Addition ---
async function saveNewItem() {
  const addInput = document.getElementById('add-input');
  const folderSelect = document.getElementById('add-folder-select');
  
  const rawInputText = addInput.value.trim();
  const folderId = folderSelect.value;

  if (!rawInputText) {
    showToast('Input cannot be empty.');
    return;
  }

  // Close modal and reset input immediately!
  addInput.value = '';
  closeModal('add-modal');
  showToast('Adding to your Mind...');

  // Create placeholder item
  const placeholderId = 'item-temp-' + Date.now();
  const placeholderItem = {
    id: placeholderId,
    created_at: new Date().toISOString(),
    type: 'note',
    title: 'Processing...',
    folders: folderId ? [folderId] : [],
    isPlaceholder: true,
    content: { raw_text: rawInputText }
  };

  // Add to local list and render visual grid immediately
  driveFiles.unshift(placeholderItem);
  renderGrid();

  // Run the background save asynchronously
  runBackgroundSave(placeholderId, rawInputText, folderId);
}

function addNewItemDirectly(rawInputText, folderId = '') {
  showToast('Adding to your Mind...');

  // Create placeholder item
  const placeholderId = 'item-temp-' + Date.now();
  const placeholderItem = {
    id: placeholderId,
    created_at: new Date().toISOString(),
    type: 'note',
    title: 'Processing...',
    folders: folderId ? [folderId] : [],
    isPlaceholder: true,
    content: { raw_text: rawInputText }
  };

  // Add to local list and render visual grid immediately
  driveFiles.unshift(placeholderItem);
  renderGrid();

  // Run the background save asynchronously
  runBackgroundSave(placeholderId, rawInputText, folderId);
}

function handleShareQueryParams() {
  console.log('Checking for share query parameters...');
  const pendingAdd = safeStorage.getItem('mymind_pending_add');
  console.log('Pending add URL in storage:', pendingAdd);
  if (pendingAdd) {
    safeStorage.removeItem('mymind_pending_add');
    showToast('Importing link: ' + pendingAdd);
    addNewItemDirectly(pendingAdd);
  }
}

async function runBackgroundSave(placeholderId, rawInputText, folderId) {
  try {
    // Check if input is a URL to scrape metadata
    const isUrl = rawInputText.startsWith('http://') || rawInputText.startsWith('https://') || rawInputText.startsWith('www.');
    let aiInputText = rawInputText;
    let scrapedImage = null;
    let scrapedTitle = null;

    if (isUrl) {
      try {
        const scrapeRes = await fetch(`/api/scrape?url=${encodeURIComponent(rawInputText)}`);
        if (scrapeRes.ok) {
          const meta = await scrapeRes.json();
          scrapedImage = meta.image;
          scrapedTitle = meta.title;
          aiInputText = `Webpage URL: ${rawInputText}\nTitle: ${meta.title}\nDescription: ${meta.description}`;
        }
      } catch (e) {
        console.error('Failed to scrape URL metadata in background:', e);
      }
    }

    // 1. Run Gemma 4 31B / Gemini 3.1 Cloud analysis
    const aiParsed = await analyzeInputWithAI(aiInputText);
    
    // 2. Build full metadata object
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      created_at: new Date().toISOString(),
      type: (aiParsed.type === 'note' && isUrl) ? 'article' : aiParsed.type,
      title: aiParsed.title || scrapedTitle || 'Saved Item',
      folders: folderId ? [folderId] : [],
      url: (aiParsed.type === 'article' || isUrl) ? rawInputText : '',
      image: scrapedImage || '',
      ai_analysis: aiParsed.ai_analysis || {
        summary: 'Saved note.',
        tags: ['inbox'],
        vibe: 'clean',
        key_takeaways: []
      },
      content: {
        raw_text: aiParsed.content?.raw_text || rawInputText,
        word_count: rawInputText.split(/\s+/).length,
        reading_time_mins: Math.max(1, Math.ceil(rawInputText.split(/\s+/).length / 200))
      }
    };

    // If it's a color, clean up hex
    if (newItem.type === 'color' && !newItem.content.raw_text.startsWith('#')) {
      newItem.content.raw_text = rawInputText;
    }

    setSyncStatus('syncing', 'Saving to Google Drive...');

    // 3. Create JSON file in Google Drive appDataFolder
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
    
    const driveFile = await createRes.json();
    
    // 4. Upload contents
    await uploadFileContent(driveFile.id, newItem);

    // Replace placeholder with final item
    newItem._drive_file_id = driveFile.id;
    const index = driveFiles.findIndex(item => item.id === placeholderId);
    if (index !== -1) {
      driveFiles[index] = newItem;
    } else {
      driveFiles.unshift(newItem);
    }

    showToast('Saved to your Mind!');
    setSyncStatus('synced', 'Synced');
    
    renderGrid();
    renderSidebarFolders(); // Update counts
  } catch (err) {
    console.error('Background save failed:', err);
    showToast('AI analysis failed. Using fallback.');

    // Fallback to local mock analysis
    const fallback = mockAnalysis(rawInputText);
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      created_at: new Date().toISOString(),
      type: fallback.type,
      title: fallback.title,
      folders: folderId ? [folderId] : [],
      url: (fallback.type === 'article') ? rawInputText : '',
      ai_analysis: fallback.ai_analysis,
      content: {
        raw_text: fallback.content.raw_text,
        word_count: rawInputText.split(/\s+/).length,
        reading_time_mins: Math.max(1, Math.ceil(rawInputText.split(/\s+/).length / 200))
      }
    };

    try {
      setSyncStatus('syncing', 'Saving fallback...');
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
      const driveFile = await createRes.json();
      await uploadFileContent(driveFile.id, newItem);
      newItem._drive_file_id = driveFile.id;

      // Replace placeholder
      const index = driveFiles.findIndex(item => item.id === placeholderId);
      if (index !== -1) {
        driveFiles[index] = newItem;
      } else {
        driveFiles.unshift(newItem);
      }
      setSyncStatus('synced', 'Synced');
    } catch (saveErr) {
      console.error('Fallback save failed:', saveErr);
      // Remove placeholder entirely if both failed
      driveFiles = driveFiles.filter(item => item.id !== placeholderId);
      showToast('Failed to save to Google Drive.');
      setSyncStatus('synced', 'Sync Failed');
    }

    renderGrid();
    renderSidebarFolders();
  }
}

// --- Item Deletion ---
async function deleteItem(itemId, driveFileId) {
  if (!confirm('Are you sure you want to forget this from your mind?')) return;

  closeModal('detail-modal');
  setSyncStatus('syncing', 'Deleting...');

  try {
    // Delete file from Google Drive
    await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    // Remove locally
    driveFiles = driveFiles.filter(item => item.id !== itemId);
    
    showToast('Forgotten.');
    setSyncStatus('synced', 'Synced');
    renderGrid();
    renderSidebarFolders(); // Update counts
  } catch (err) {
    console.error('Failed to delete item:', err);
    showToast('Failed to delete from Google Drive.');
    setSyncStatus('synced', 'Sync Failed');
  }
}

// --- Masonry Rendering Engine ---
function renderGrid() {
  const grid = document.getElementById('mind-grid');
  const emptyState = document.getElementById('empty-state');
  
  grid.innerHTML = '';
  
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  
  // Filter items based on current view/folder and search text
  const filteredItems = driveFiles.filter(item => {
    // 1. Filter by navigation view
    if (currentFilter.startsWith('folder-')) {
      const folderId = currentFilter.substring(7);
      if (!item.folders || !item.folders.includes(folderId)) return false;
    } else if (currentFilter === 'type-quote' && item.type !== 'quote') return false;
    else if (currentFilter === 'type-article' && item.type !== 'article') return false;
    else if (currentFilter === 'type-note' && item.type !== 'note') return false;
    else if (currentFilter === 'type-color' && item.type !== 'color') return false;

    // 2. Filter by search query
    if (query) {
      const searchInTitle = item.title ? item.title.toLowerCase().includes(query) : false;
      const searchInText = item.content && item.content.raw_text ? item.content.raw_text.toLowerCase().includes(query) : false;
      const searchInSummary = item.ai_analysis && item.ai_analysis.summary ? item.ai_analysis.summary.toLowerCase().includes(query) : false;
      const searchInVibe = item.ai_analysis && item.ai_analysis.vibe ? item.ai_analysis.vibe.toLowerCase().includes(query) : false;
      const searchInTags = item.ai_analysis && item.ai_analysis.tags ? item.ai_analysis.tags.some(tag => tag.toLowerCase().includes(query)) : false;
      const searchInType = item.type.toLowerCase() === query;

      return searchInTitle || searchInText || searchInSummary || searchInVibe || searchInTags || searchInType;
    }

    return true;
  });

  if (filteredItems.length === 0) {
    emptyState.removeAttribute('hidden');
    grid.style.display = 'none';
  } else {
    emptyState.setAttribute('hidden', 'true');
    grid.style.display = 'block';

    filteredItems.forEach(item => {
      const card = document.createElement('div');
      card.dataset.id = item.id;

      if (item.isPlaceholder) {
        card.className = 'mind-card mind-card--placeholder';
        card.innerHTML = `
          <div class="card-placeholder-shimmer">
            <div class="card-placeholder-header">
              <span class="sparkle-icon-animated">✨</span>
              <span>MyMindSpace is thinking...</span>
            </div>
            <div class="card-placeholder-line card-placeholder-line--long"></div>
            <div class="card-placeholder-line card-placeholder-line--short"></div>
          </div>
        `;
        card.addEventListener('click', () => showToast('AI is still processing this item...'));
        grid.appendChild(card);
        return;
      }

      card.className = `mind-card mind-card--${item.type}`;

      // Card rendering template based on types
      if (item.type === 'quote') {
        const quotePart = extractQuoteParts(item.content.raw_text);
        card.innerHTML = `
          <div class="card-quote-text">“${quotePart.text}”</div>
          <div class="card-quote-author">${quotePart.author || item.title || 'Unknown'}</div>
        `;
      } 
      else if (item.type === 'color') {
        const hex = item.content.raw_text.trim();
        card.innerHTML = `
          <div class="card-color-swatch" style="background-color: ${hex};"></div>
          <div class="card-color-meta">
            <span class="card-color-hex">${hex}</span>
            <span class="card-color-name">${item.ai_analysis.vibe}</span>
          </div>
        `;
      } 
      else if (item.type === 'article') {
        const thumbImg = item.image ? `<img class="card-article-thumb" src="${item.image}" alt="${item.title}" />` : '';
        card.innerHTML = `
          ${thumbImg}
          <div class="card-article-content">
            <div class="card-article-source">${item.title}</div>
            <div class="card-article-title">${item.ai_analysis.summary}</div>
            <div class="card-tags">
              ${(item.ai_analysis.tags || []).slice(0, 3).map(tag => `<span class="card-tag">#${tag}</span>`).join('')}
            </div>
          </div>
        `;
      } 
      else { // note
        card.innerHTML = `
          <div class="card-note-title">${item.title}</div>
          <div class="card-note-desc">${item.ai_analysis.summary}</div>
          <div class="card-tags">
            ${(item.ai_analysis.tags || []).slice(0, 3).map(tag => `<span class="card-tag">#${tag}</span>`).join('')}
          </div>
        `;
      }

      // Add click to open Detail Modal
      card.addEventListener('click', () => showDetailModal(item));

      grid.appendChild(card);
    });
  }
}

function extractQuoteParts(rawText) {
  // Simple quote separator logic, e.g. "To be or not to be - Shakespeare"
  const splitIndex = rawText.lastIndexOf('-');
  if (splitIndex !== -1) {
    return {
      text: rawText.substring(0, splitIndex).replace(/["“]/g, '').trim(),
      author: rawText.substring(splitIndex + 1).replace(/["]/g, '').trim()
    };
  }
  return { text: rawText.replace(/["“]/g, ''), author: '' };
}

// --- Detail Card Modal Engine ---
function showDetailModal(item) {
  const contentContainer = document.getElementById('detail-modal-content');
  const tagsContainer = document.getElementById('detail-tags-list');
  const typeBadge = document.getElementById('detail-type-badge');

  typeBadge.textContent = item.type;
  tagsContainer.innerHTML = (item.ai_analysis.tags || []).map(tag => `<span class="card-tag">#${tag}</span>`).join('');

  // Handle deletion binding
  const btnDelete = document.getElementById('btn-delete-item');
  const newBtnDelete = btnDelete.cloneNode(true);
  btnDelete.parentNode.replaceChild(newBtnDelete, btnDelete); // Remove previous listeners
  newBtnDelete.addEventListener('click', () => deleteItem(item.id, item._drive_file_id));

  // Render modal content
  if (item.type === 'quote') {
    const parts = extractQuoteParts(item.content.raw_text);
    contentContainer.innerHTML = `
      <div class="detail-content">
        <div class="detail-quote-display">
          “${parts.text}”
          <div class="detail-quote-author">${parts.author || item.title || 'Unknown'}</div>
        </div>
        <div class="detail-summary-box">
          <div class="detail-summary-title">AI Reflection</div>
          <p>${item.ai_analysis.summary}</p>
        </div>
      </div>
    `;
  } 
  else if (item.type === 'color') {
    const hex = item.content.raw_text;
    contentContainer.innerHTML = `
      <div class="detail-content">
        <div class="detail-color-large" style="background-color: ${hex};">${hex}</div>
        <h2 class="detail-title">${item.title}</h2>
        <div class="detail-summary-box">
          <div class="detail-summary-title">AI Vibe & Mood Description</div>
          <p>${item.ai_analysis.summary}</p>
        </div>
      </div>
    `;
  } 
  else if (item.type === 'article') {
    const detailImg = item.image ? `<img class="detail-article-image" src="${item.image}" alt="${item.title}" style="inline-size: 100%; block-size: auto; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 12px; margin-block-end: 20px;" />` : '';
    contentContainer.innerHTML = `
      <div class="detail-content">
        ${detailImg}
        <h2 class="detail-title">${item.title}</h2>
        <a href="${item.url}" target="_blank" class="detail-source-link">🔗 View original article</a>
        
        <div class="detail-summary-box">
          <div class="detail-summary-title">AI Abstract Summary</div>
          <p>${item.ai_analysis.summary}</p>
        </div>

        ${item.ai_analysis.key_takeaways && item.ai_analysis.key_takeaways.length > 0 ? `
          <div>
            <h4 class="detail-summary-title" style="margin-block-end: 16px;">Key Takeaways</h4>
            <div class="detail-key-points">
              ${item.ai_analysis.key_takeaways.map(pt => `
                <div class="detail-point-item">
                  <span class="detail-point-bullet">✦</span>
                  <span>${pt}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${item.content.raw_text ? `
          <div>
            <h4 class="detail-summary-title" style="margin-block-end: 16px;">Parsed Document Content</h4>
            <div class="detail-body-text">${item.content.raw_text}</div>
          </div>
        ` : ''}
      </div>
    `;
  } 
  else { // note
    contentContainer.innerHTML = `
      <div class="detail-content">
        <h2 class="detail-title">${item.title}</h2>
        
        <div class="detail-summary-box">
          <div class="detail-summary-title">AI Abstract Summary</div>
          <p>${item.ai_analysis.summary}</p>
        </div>

        ${item.ai_analysis.key_takeaways && item.ai_analysis.key_takeaways.length > 0 ? `
          <div>
            <h4 class="detail-summary-title" style="margin-block-end: 16px;">Action Items & Outline</h4>
            <div class="detail-key-points">
              ${item.ai_analysis.key_takeaways.map(pt => `
                <div class="detail-point-item">
                  <span class="detail-point-bullet">✦</span>
                  <span>${pt}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div>
          <h4 class="detail-summary-title" style="margin-block-end: 16px;">Raw Content</h4>
          <div class="detail-body-text">${item.content.raw_text}</div>
        </div>
      </div>
    `;
  }

  openModal('detail-modal');
}

// --- Configuration Management ---
function saveSettings(e) {
  e.preventDefault();
  const geminiKey = document.getElementById('setting-gemini-key').value.trim();
  const model = document.getElementById('setting-model').value;

  safeStorage.setItem(STORAGE_KEYS.GEMINI_KEY, geminiKey);
  safeStorage.setItem(STORAGE_KEYS.AI_MODEL, model);

  closeModal('settings-modal');
  showToast('Settings saved.');
}

// --- App Control Utilities ---
function logout() {
  safeStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  accessToken = null;
  driveFiles = [];
  folders = [];
  showLandingPage();
  showToast('Successfully logged out.');
}

function setSyncStatus(status, text) {
  const syncBadge = document.getElementById('sync-status');
  const syncText = document.getElementById('sync-text');
  
  syncBadge.className = 'sync-badge';
  
  if (status === 'syncing') {
    syncBadge.classList.add('syncing');
  }
  
  syncText.textContent = text;
}

function showToast(message) {
  // Try to use web Notification if active, or fall back to native console/overlay alert
  console.log('[Toast Notification]:', message);
  
  let toast = document.getElementById('custom-toast-alert');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'custom-toast-alert';
    toast.style.cssText = `
      position: fixed;
      bottom: 40px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-glass-hover);
      color: #fff;
      padding: 14px 28px;
      border-radius: var(--radius-md);
      font-size: 0.95rem;
      font-weight: 500;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
      z-index: 200;
      pointer-events: none;
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s;
      opacity: 0;
    `;
    document.body.appendChild(toast);
  }
  
  toast.textContent = message;
  toast.style.transform = 'translateX(-50%) translateY(0)';
  toast.style.opacity = '1';
  
  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(100px)';
    toast.style.opacity = '0';
  }, 3000);
}

async function refreshData() {
  showToast('Refreshing your MindSpace...');
  try {
    await verifyAndFetchData();
  } catch (err) {
    console.error('Failed to refresh data:', err);
    showToast('Failed to sync. Please try again.');
  }
}

// --- Clipboard URL Auto-Detection ---
async function checkClipboardForUrl() {
  if (!accessToken) return; // Only check if logged in
  
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      const trimmed = (text || '').trim();
      
      const isUrl = trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('www.');
      if (isUrl) {
        // Prevent duplicate prompts by checking if URL is already saved
        const alreadySaved = driveFiles.some(item => item.url === trimmed || item.content?.raw_text === trimmed);
        if (alreadySaved) return;
        
        showClipboardPrompt(trimmed);
      }
    }
  } catch (err) {
    // Fail silently (e.g. permission denied)
    console.log('Clipboard access not allowed or supported:', err);
  }
}

function showClipboardPrompt(url) {
  if (document.getElementById('clipboard-prompt')) return;
  
  const promptDiv = document.createElement('div');
  promptDiv.id = 'clipboard-prompt';
  promptDiv.className = 'clipboard-prompt-banner';
  promptDiv.innerHTML = `
    <div class="prompt-content">
      <span class="prompt-icon">📋</span>
      <div class="prompt-text">
        <span class="prompt-title">Link detected in clipboard</span>
        <span class="prompt-url">${url.length > 35 ? url.substring(0, 35) + '...' : url}</span>
      </div>
    </div>
    <div class="prompt-actions">
      <button class="btn-prompt btn-prompt--dismiss" id="btn-clip-dismiss">Ignore</button>
      <button class="btn-prompt btn-prompt--confirm" id="btn-clip-add">Add</button>
    </div>
  `;
  
  document.body.appendChild(promptDiv);
  
  document.getElementById('btn-clip-dismiss').addEventListener('click', () => {
    promptDiv.remove();
  });
  
  document.getElementById('btn-clip-add').addEventListener('click', () => {
    promptDiv.remove();
    addNewItemDirectly(url);
  });
  
  // Auto-dismiss after 10 seconds
  setTimeout(() => {
    if (document.body.contains(promptDiv)) {
      promptDiv.remove();
    }
  }, 10000);
}
