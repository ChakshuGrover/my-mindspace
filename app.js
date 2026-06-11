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
let codeClient;
let accessToken = null;
let userEmail = null;
let googleUserId = null;
let settingsFileId = null;
let syncIntervalId = null;
let lastSyncTime = 0;
let onAuthSuccessCallback = null;
let driveFiles = []; // Array of downloaded mind items
let folders = []; // Array of virtual folders
let currentFilter = 'all'; // 'all', 'type-quote', 'folder-ID', etc.
let searchTimeout = null;
let aiFilteredIds = null;
let aiSearchAbortController = null;
let currentDetailItem = null;
let isEditingDetail = false;
let activeAddType = 'general'; // 'general', 'note', 'todo', 'link'
let chatFocusItem = null;
let openChatFn = null;

// --- Spatial Canvas (Mind Map) Global State ---
let currentViewMode = 'grid'; // 'grid' or 'spatial'
let canvasZoom = 1;
let canvasViewMode = localStorage.getItem('mymind_canvas_view_mode') || 'cards';
let canvasPanX = 0;
let canvasPanY = 0;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let panStartOffset = { x: 0, y: 0 };
let isLinking = false;
let linkSourceId = null;
let activeDragItem = null;
let activeDragStart = { x: 0, y: 0 };
let activeDragMouseStart = { x: 0, y: 0 };
let isDraggingNode = false;
let canvasNodeDragged = false;
const nodeSaveDebounceTimers = {};
let canvasPendingCoords = null;
let lastRenderedSpatialItems = [];
let physicsAnimationId = null;
let physicsAlpha = 0;

// Default credentials for sandbox testing (User can override in settings)
const DEFAULT_CLIENT_ID = '345073896444-jvm03jjn5dn6pfh95d7jbtlh4shq4ooj.apps.googleusercontent.com';

// LocalStorage Keys
const STORAGE_KEYS = {
  CLIENT_ID: 'mymind_client_id',
  GEMINI_KEY: 'mymind_gemini_key',
  ACCESS_TOKEN: 'mymind_access_token'
};

// --- Local Cache Helpers ---
function sanitizeMindItem(item) {
  if (!item) return null;
  if (!item.type) item.type = 'note';
  if (!item.title) item.title = 'Untitled Note';
  if (!item.content) {
    item.content = {
      raw_text: '',
      todos: []
    };
  } else {
    if (!item.content.raw_text) item.content.raw_text = '';
    if (!item.content.todos) item.content.todos = [];
  }
  if (!item.ai_analysis) {
    item.ai_analysis = {
      summary: '',
      detailed_summary: '',
      vibe: '',
      tags: [],
      key_takeaways: []
    };
  } else {
    if (!item.ai_analysis.summary) item.ai_analysis.summary = '';
    if (!item.ai_analysis.detailed_summary) item.ai_analysis.detailed_summary = '';
    if (!item.ai_analysis.vibe) item.ai_analysis.vibe = '';
    if (!item.ai_analysis.tags) item.ai_analysis.tags = [];
    if (!item.ai_analysis.key_takeaways) item.ai_analysis.key_takeaways = [];
  }
  return item;
}

function loadCachedData() {
  try {
    const cachedFolders = safeStorage.getItem('mymind_cached_folders');
    if (cachedFolders) {
      folders = JSON.parse(cachedFolders);
    }
    const cachedFiles = safeStorage.getItem('mymind_cached_files');
    if (cachedFiles) {
      driveFiles = JSON.parse(cachedFiles).map(sanitizeMindItem).filter(Boolean);
    }
  } catch (e) {
    console.error('Error loading cached data:', e);
  }
}

function saveFilesCache() {
  try {
    // Strip heavy RAG chunks from local storage cache to stay well under the 5MB localStorage limit
    const lightFiles = driveFiles.map(item => {
      const copy = { ...item };
      delete copy.rag_chunks;
      return copy;
    });
    safeStorage.setItem('mymind_cached_files', JSON.stringify(lightFiles));
  } catch (e) {
    console.error('Failed to save files cache:', e);
  }
}

function saveFoldersCache() {
  try {
    safeStorage.setItem('mymind_cached_folders', JSON.stringify(folders));
  } catch (e) {
    console.error('Failed to save folders cache:', e);
  }
}



function initApp() {
  // Initialize IndexedDB database for RAG search
  MindDB.init().catch(err => console.error('Failed to init MindDB:', err));

  // Capture pending share parameters immediately on startup
  let addUrl = null;
  const search = window.location.search;
  const addIndex = search.indexOf('add=');
  if (addIndex !== -1) {
    // Extract everything after 'add='
    const rawAdd = search.substring(addIndex + 4);
    try {
      addUrl = decodeURIComponent(rawAdd);
    } catch (e) {
      addUrl = rawAdd;
    }
  } else {
    const urlParams = new URLSearchParams(search);
    addUrl = urlParams.get('add');
  }

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
  }

  // Load configuration and apply appearance
  const savedOpacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');
  applyCardOpacity(savedOpacity);
  initSettingsForm();

  // Bind Event Listeners
  setupEventListeners();

  // Load Google APIs
  loadGoogleLibraries();

  // Start background auto-sync loop
  startAutoSyncLoop();

  // Register Service Worker for PWA support
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => {
          console.log('Service Worker registered successfully:', reg.scope);
          
          // Force update check
          reg.update().catch(() => {});
          
          reg.onupdatefound = () => {
            const installingWorker = reg.installing;
            if (installingWorker) {
              installingWorker.onstatechange = () => {
                if (installingWorker.state === 'installed') {
                  if (navigator.serviceWorker.controller) {
                    console.log('New content available, reloading page to apply updates...');
                    window.location.reload();
                  }
                }
              };
            }
          };
        })
        .catch((err) => console.error('Service Worker registration failed:', err));
    });
  }

  // Fast check: if not logged in, skip loader and show landing page immediately
  const savedToken = safeStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  if (!savedToken) {
    showLandingPage();
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
    codeClient = google.accounts.oauth2.initCodeClient({
      client_id: safeStorage.getItem(STORAGE_KEYS.CLIENT_ID),
      scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
      ux_mode: 'popup',
      redirect_uri: 'postmessage',
      callback: async (authResponse) => {
        if (authResponse.error !== undefined) {
          console.error('Oauth authorization error:', authResponse.error);
          showToast('Authentication failed or expired.');
          logout();
          return;
        }
        
        if (authResponse.code) {
          setSyncStatus('syncing', 'Authenticating...');
          try {
            await exchangeCodeForToken(authResponse.code);
          } catch (err) {
            console.error('Failed to exchange code:', err);
            showToast('Authentication failed: ' + err.message);
            logout();
          }
        }
      }
    });
    console.log('Google Identity Code Client Initialized');

    // Auto-connect if access token is already saved
    const savedToken = safeStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    if (savedToken) {
      accessToken = savedToken;
      ensureValidToken(() => {
        verifyAndFetchData();
      }, true); // force landing page redirect if expired on startup
    } else {
      showLandingPage();
    }
  } catch (err) {
    console.error('Error initializing Google Identity Services Client:', err);
    showLandingPage();
  }
}

async function exchangeCodeForToken(code) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      code: code,
      redirect_uri: 'postmessage'
    })
  });
  
  if (!res.ok) {
    let errData;
    try {
      errData = await res.json();
    } catch(e) {}
    const errMsg = errData?.error || `HTTP error ${res.status}`;
    throw new Error(errMsg);
  }
  
  const data = await res.json();
  accessToken = data.access_token;
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  
  safeStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  safeStorage.setItem('mymind_token_expires_at', expiresAt);
  
  hideSessionExpiredBanner();
  
  if (onAuthSuccessCallback) {
    const cb = onAuthSuccessCallback;
    onAuthSuccessCallback = null;
    cb();
  } else {
    verifyAndFetchData();
  }
}

async function refreshAccessTokenFromServer() {
  const res = await fetch('/api/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include'
  });
  
  if (!res.ok) {
    let errData;
    try {
      errData = await res.json();
    } catch(e) {}
    const errMsg = errData?.error || `HTTP error ${res.status}`;
    throw new Error(errMsg);
  }
  
  const data = await res.json();
  accessToken = data.access_token;
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  
  safeStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  safeStorage.setItem('mymind_token_expires_at', expiresAt);
  
  hideSessionExpiredBanner();
  return accessToken;
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Login / Logout Buttons
  document.getElementById('btn-login').addEventListener('click', () => {
    if (codeClient) {
      codeClient.requestCode();
    } else {
      showToast('Authentication library loading. Please try again in a moment.');
    }
  });
  
  document.getElementById('btn-logout').addEventListener('click', () => { logout(); closeMobileSidebar(); });
  document.getElementById('btn-mobile-logout').addEventListener('click', logout);
  document.getElementById('btn-refresh').addEventListener('click', () => { refreshData(); closeMobileSidebar(); });
  document.getElementById('btn-mobile-refresh').addEventListener('click', refreshData);

  const btnMobileSearch = document.getElementById('btn-mobile-search');
  if (btnMobileSearch) {
    btnMobileSearch.addEventListener('click', () => {
      const header = document.querySelector('.workspace-header');
      if (header) {
        const isOpen = header.classList.toggle('search-open');
        if (isOpen) {
          const input = document.getElementById('search-input');
          if (input) input.focus();
        } else {
          const input = document.getElementById('search-input');
          if (input && input.value !== '') {
            input.value = '';
          }
          resetAISearch();
          renderGrid();
        }
      }
    });
  }

  // Mobile menu trigger and overlay clicking
  const btnMobileMenu = document.getElementById('btn-mobile-menu');
  if (btnMobileMenu) {
    btnMobileMenu.addEventListener('click', toggleMobileSidebar);
  }
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeMobileSidebar);
  }

  // Modals & Panels open/close
  const openSettings = () => {
    initSettingsForm();
    openModal('settings-modal');
    closeMobileSidebar();
  };
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', openSettings);
  
  const btnMobileSettings = document.getElementById('btn-mobile-settings');
  if (btnMobileSettings) btnMobileSettings.addEventListener('click', openSettings);
  
  
  const cancelSettings = () => {
    revertLiveSettings();
    closeModal('settings-modal');
  };
  const btnCloseSettings = document.getElementById('btn-close-settings');
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', cancelSettings);

  // Chat Modal open/close and form submission
  const openChat = (item = null) => {
    chatFocusItem = (item && item.id) ? item : null;
    
    // Update the Chat Title / Scope badge in the UI
    const chatHeaderTitle = document.querySelector('#chat-modal .modal-header h3');
    const existingBadge = document.getElementById('chat-scope-badge');
    if (existingBadge) existingBadge.remove();
    
    const chatScopeArea = document.getElementById('chat-scope-area');
    const selector = document.getElementById('chat-card-selector');

    if (chatFocusItem) {
      chatHeaderTitle.textContent = 'Chatting with Card';
      
      const badge = document.createElement('div');
      badge.id = 'chat-scope-badge';
      badge.className = 'chat-scope-badge';
      badge.innerHTML = `
        <span>Focus: <strong>${chatFocusItem.title || 'Untitled Note'}</strong></span>
        <button id="btn-clear-chat-scope" class="btn-clear-scope" title="Clear focus, chat with all items">&times;</button>
      `;
      
      // Insert badge under the header
      const header = document.querySelector('#chat-modal .modal-header');
      if (header) {
        header.parentNode.insertBefore(badge, header.nextSibling);
      }
      
      const btnClear = document.getElementById('btn-clear-chat-scope');
      if (btnClear) {
        btnClear.addEventListener('click', () => {
          openChat(null); // Clear scope
        });
      }

      // Hide the selector dropdown when focusing on a specific card
      if (chatScopeArea) chatScopeArea.style.display = 'none';
    } else {
      chatHeaderTitle.textContent = 'Chat with your Mind';

      // Show the selector dropdown when in global chat mode
      if (chatScopeArea) chatScopeArea.style.display = 'block';

      // Populate/Update the selector options
      if (selector) {
        // Reset the selector contents to default
        selector.innerHTML = '<option value="">🔍 Focus on a specific card...</option>';

        // Filter for active, non-placeholder, non-color items
        const eligibleItems = driveFiles.filter(i => !i.isPlaceholder && i.type !== 'color');
        
        // Sort alphabetically
        eligibleItems.sort((a, b) => {
          const titleA = (a.title || 'Untitled Note').toLowerCase();
          const titleB = (b.title || 'Untitled Note').toLowerCase();
          return titleA.localeCompare(titleB);
        });

        eligibleItems.forEach(i => {
          const opt = document.createElement('option');
          opt.value = i.id;
          
          let typeLabel = i.type || 'note';
          if (typeLabel === 'list') typeLabel = 'checklist';
          
          opt.textContent = `${i.title || 'Untitled Note'} [${typeLabel.toUpperCase()}]`;
          selector.appendChild(opt);
        });

        // Set value to empty
        selector.value = "";
      }
    }

    openModal('chat-modal');
    closeMobileSidebar();
    setTimeout(() => {
      document.getElementById('chat-input')?.focus();
    }, 100);
  };
  openChatFn = openChat;
  
  const btnChat = document.getElementById('btn-chat');
  if (btnChat) btnChat.addEventListener('click', () => openChat(null));
  const btnMobileChat = document.getElementById('btn-mobile-chat');
  if (btnMobileChat) btnMobileChat.addEventListener('click', () => openChat(null));
  const btnCloseChat = document.getElementById('btn-close-chat-modal');
  if (btnCloseChat) btnCloseChat.addEventListener('click', () => closeModal('chat-modal'));
  const chatBackdrop = document.getElementById('chat-modal-backdrop');
  if (chatBackdrop) chatBackdrop.addEventListener('click', () => closeModal('chat-modal'));
  const chatForm = document.getElementById('chat-form');
  if (chatForm) chatForm.addEventListener('submit', handleChatSubmit);

  const chatCardSelector = document.getElementById('chat-card-selector');
  if (chatCardSelector) {
    chatCardSelector.addEventListener('change', (e) => {
      const selectedId = e.target.value;
      if (selectedId) {
        const item = driveFiles.find(f => f.id === selectedId);
        if (item) openChat(item);
      }
    });
  }
  
  const btnCloseSettingsModal = document.getElementById('btn-close-settings-modal');
  if (btnCloseSettingsModal) btnCloseSettingsModal.addEventListener('click', cancelSettings);
  
  const settingsModalBackdrop = document.getElementById('settings-modal-backdrop');
  if (settingsModalBackdrop) settingsModalBackdrop.addEventListener('click', cancelSettings);


  const settingCardOpacity = document.getElementById('setting-card-opacity');
  if (settingCardOpacity) {
    settingCardOpacity.addEventListener('input', (e) => {
      const opacityVal = (e.target.value / 100).toFixed(2);
      const settingOpacityVal = document.getElementById('setting-opacity-val');
      if (settingOpacityVal) settingOpacityVal.textContent = e.target.value + '%';
      document.documentElement.style.setProperty('--card-opacity', opacityVal);
    });
  }

  const fabContainer = document.getElementById('floating-add-container');
  
  if (fabContainer) {
    document.getElementById('btn-quick-add').addEventListener('click', (e) => {
      e.stopPropagation();
      fabContainer.classList.toggle('open');
    });

    // Close FAB menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!fabContainer.contains(e.target)) {
        fabContainer.classList.remove('open');
      }
    });

    // Helper for inserting markdown tags
    const insertMarkdownHelper = (tag) => {
      const textarea = document.getElementById('add-input');
      if (!textarea) return;
      
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selectedText = text.substring(start, end);
      
      let replacement = '';
      let cursorOffset = 0;
      
      switch (tag) {
        case 'bold':
          replacement = `**${selectedText}**`;
          cursorOffset = selectedText ? 0 : 2;
          break;
        case 'italic':
          replacement = `*${selectedText}*`;
          cursorOffset = selectedText ? 0 : 1;
          break;
        case 'h1':
          replacement = `${start === 0 || text[start - 1] === '\n' ? '' : '\n'}# ${selectedText}`;
          cursorOffset = 0;
          break;
        case 'h2':
          replacement = `${start === 0 || text[start - 1] === '\n' ? '' : '\n'}## ${selectedText}`;
          cursorOffset = 0;
          break;
        case 'h3':
          replacement = `${start === 0 || text[start - 1] === '\n' ? '' : '\n'}### ${selectedText}`;
          cursorOffset = 0;
          break;
        case 'list':
          replacement = `${start === 0 || text[start - 1] === '\n' ? '' : '\n'}- ${selectedText}`;
          cursorOffset = 0;
          break;
        case 'quote':
          replacement = `${start === 0 || text[start - 1] === '\n' ? '' : '\n'}> ${selectedText}`;
          cursorOffset = 0;
          break;
        case 'code':
          replacement = `\`${selectedText}\``;
          cursorOffset = selectedText ? 0 : 1;
          break;
      }
      
      textarea.value = text.substring(0, start) + replacement + text.substring(end);
      textarea.focus();
      
      // Reset selection
      const newCursorPos = start + replacement.length - cursorOffset;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      
      // Trigger input event to update counts
      textarea.dispatchEvent(new Event('input'));
    };

    // Bind Markdown Toolbar buttons
    document.querySelectorAll('#add-markdown-toolbar button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const tag = btn.dataset.tag;
        insertMarkdownHelper(tag);
      });
    });

    // Bind Word Counter
    const addInputEl = document.getElementById('add-input');
    const wordCountEl = document.getElementById('add-word-count');
    if (addInputEl && wordCountEl) {
      addInputEl.addEventListener('input', () => {
        const text = addInputEl.value.trim();
        const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
        const charCount = text.length;
        wordCountEl.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''} | ${charCount} char${charCount !== 1 ? 's' : ''}`;
      });
    }

    const configureAddModal = (type) => {
      activeAddType = type;
      if (currentViewMode === 'spatial') {
        canvasPendingCoords = getCanvasCenterCoords();
      }

      const addModalTitle = document.getElementById('add-modal-title');
      const addInput = document.getElementById('add-input');
      const titleInput = document.getElementById('add-title-input');
      const markdownToolbar = document.getElementById('add-markdown-toolbar');
      const wordCountContainer = document.getElementById('add-word-count');
      const todoContainer = document.getElementById('add-todo-container');
      const todoToggle = document.getElementById('add-todo-toggle');

      // Reset default modal configuration
      if (todoToggle) todoToggle.checked = false;
      if (todoContainer) todoContainer.style.display = 'flex';
      if (titleInput) {
        titleInput.value = '';
        titleInput.style.display = 'none';
      }
      if (markdownToolbar) markdownToolbar.style.display = 'none';
      if (wordCountContainer) {
        wordCountContainer.style.display = 'none';
        wordCountContainer.textContent = '0 words | 0 chars';
      }

      if (type === 'note') {
        if (addModalTitle) addModalTitle.textContent = 'Create Note';
        if (addInput) addInput.placeholder = 'Write your note content here (Markdown supported)...';
        if (todoContainer) todoContainer.style.display = 'none';
        if (titleInput) {
          titleInput.placeholder = 'Note Title...';
          titleInput.style.display = 'block';
        }
        if (markdownToolbar) markdownToolbar.style.display = 'flex';
        if (wordCountContainer) wordCountContainer.style.display = 'flex';
      } else if (type === 'todo') {
        if (addModalTitle) addModalTitle.textContent = 'Create Checklist';
        if (addInput) addInput.placeholder = 'Enter tasks (one per line)...';
        if (todoToggle) todoToggle.checked = true;
        if (todoContainer) todoContainer.style.display = 'none';
        if (titleInput) {
          titleInput.placeholder = 'Checklist Title...';
          titleInput.style.display = 'block';
        }
      } else if (type === 'link') {
        if (addModalTitle) addModalTitle.textContent = 'Save Link';
        if (addInput) addInput.placeholder = 'Paste a link / URL (e.g., https://...)';
        if (todoContainer) todoContainer.style.display = 'none';
        if (titleInput) {
          titleInput.placeholder = 'Link Title (Optional)...';
          titleInput.style.display = 'block';
        }
      } else {
        if (addModalTitle) addModalTitle.textContent = 'Remember Something';
        if (addInput) addInput.placeholder = 'Paste a link, write a note, or write a checklist...';
      }

      fabContainer.classList.remove('open');
      openModal('add-modal');
    };

    document.getElementById('btn-add-note').addEventListener('click', () => configureAddModal('note'));
    document.getElementById('btn-add-todo').addEventListener('click', () => configureAddModal('todo'));
    document.getElementById('btn-add-link').addEventListener('click', () => configureAddModal('link'));
  } else {
    document.getElementById('btn-quick-add').addEventListener('click', () => {
      if (currentViewMode === 'spatial') {
        canvasPendingCoords = getCanvasCenterCoords();
      }
      openModal('add-modal');
    });
  }

  document.getElementById('btn-cancel-add').addEventListener('click', () => closeModal('add-modal'));
  document.getElementById('btn-close-add-modal').addEventListener('click', () => closeModal('add-modal'));
  document.getElementById('add-modal-backdrop').addEventListener('click', () => closeModal('add-modal'));

  // Quick Add Color Picker Swatches
  document.querySelectorAll('#add-modal .color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#add-modal .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  });

  document.getElementById('btn-new-folder').addEventListener('click', () => openModal('folder-modal'));
  document.getElementById('btn-cancel-folder').addEventListener('click', () => closeModal('folder-modal'));
  document.getElementById('btn-close-folder-modal').addEventListener('click', () => closeModal('folder-modal'));
  document.getElementById('folder-modal-backdrop').addEventListener('click', () => closeModal('folder-modal'));

  document.getElementById('btn-close-detail-modal').addEventListener('click', () => closeModal('detail-modal'));
  document.getElementById('detail-modal-backdrop').addEventListener('click', () => closeModal('detail-modal'));

  const addFolderSelect = document.getElementById('add-folder-select');
  if (addFolderSelect) {
    addFolderSelect.addEventListener('change', (e) => {
      const container = document.getElementById('add-new-folder-input-container');
      if (e.target.value === '__NEW_FOLDER__') {
        container.style.display = 'flex';
        document.getElementById('add-new-folder-name').focus();
      } else {
        container.style.display = 'none';
        document.getElementById('add-new-folder-name').value = '';
      }
    });
  }

  const btnReconnect = document.getElementById('btn-reconnect');
  if (btnReconnect) {
    btnReconnect.addEventListener('click', () => {
      if (codeClient) {
        codeClient.requestCode();
      } else {
        showToast('Google identity client not initialized. Please refresh.');
      }
    });
  }

  // Save actions
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-folder').addEventListener('click', saveNewFolder);
  document.getElementById('btn-save-add').addEventListener('click', saveNewItem);

  const btnCopyShortcutKey = document.getElementById('btn-copy-shortcut-key');
  if (btnCopyShortcutKey) {
    btnCopyShortcutKey.addEventListener('click', async () => {
      try {
        btnCopyShortcutKey.textContent = 'Fetching Key...';
        btnCopyShortcutKey.disabled = true;
        const res = await fetch('/api/get-token');
        if (!res.ok) {
          throw new Error('Failed to fetch sharing key');
        }
        const data = await res.json();
        if (data.refresh_token) {
          await navigator.clipboard.writeText(data.refresh_token);
          showToast('iOS Shortcut Sharing Key copied to clipboard!');
          btnCopyShortcutKey.textContent = 'Copied!';
        } else {
          throw new Error('No refresh token returned');
        }
      } catch (err) {
        console.error('Failed to copy sharing key:', err);
        showToast('Failed to copy key. Please re-authenticate.');
        btnCopyShortcutKey.textContent = 'Failed';
      } finally {
        setTimeout(() => {
          btnCopyShortcutKey.textContent = 'Copy iOS Shortcut Sharing Key';
          btnCopyShortcutKey.disabled = false;
        }, 3000);
      }
    });
  }

  // Search filter typing
  document.getElementById('search-input').addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchTimeout);
    
    if (!query) {
      resetAISearch();
      renderGrid();
      return;
    }

    // Visual feedback: show thinking indicator
    const container = document.querySelector('.search-container');
    if (container) container.classList.add('ai-searching');
    const loader = document.getElementById('search-loader');
    if (loader) loader.removeAttribute('hidden');

    searchTimeout = setTimeout(() => {
      executeAISearch(query);
    }, 600);
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
      const targetId = e.currentTarget.id;
      
      if (targetId === 'btn-chat') {
        closeMobileSidebar();
        return;
      }
      
      if (targetId === 'nav-view-spatial') {
        currentViewMode = 'spatial';
        currentFilter = 'all';
        document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
        e.currentTarget.classList.add('active');
      } else if (targetId === 'nav-view-grid') {
        currentViewMode = 'grid';
        currentFilter = 'all';
        document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
        e.currentTarget.classList.add('active');
      } else {
        // Standard category filters (Notes, Articles, To-Dos)
        document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentFilter = e.currentTarget.dataset.filter;
      }
      
      renderGrid();
      closeMobileSidebar();
    });
  });

  // Initialize Spatial Canvas Zoom/Pan/Link Events
  initSpatialCanvasEvents();

  // Onboarding modal actions
  const btnSkipOnboarding = document.getElementById('btn-skip-onboarding');
  if (btnSkipOnboarding) btnSkipOnboarding.addEventListener('click', skipOnboarding);

  const btnSaveOnboarding = document.getElementById('btn-save-onboarding');
  if (btnSaveOnboarding) btnSaveOnboarding.addEventListener('click', saveOnboardingSettings);

  const onboardingBackdrop = document.getElementById('onboarding-backdrop');
  if (onboardingBackdrop) onboardingBackdrop.addEventListener('click', skipOnboarding);
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
  document.body.classList.add('modal-open');
  
  if (modalId === 'add-modal') {
    const titleInput = document.getElementById('add-title-input');
    if (titleInput && titleInput.style.display !== 'none') {
      titleInput.focus();
    } else {
      document.getElementById('add-input').focus();
    }
    populateFolderSelect();
    // Reset inline folder fields
    const folderSelect = document.getElementById('add-folder-select');
    if (folderSelect) folderSelect.value = '';
    const newFolderContainer = document.getElementById('add-new-folder-input-container');
    if (newFolderContainer) newFolderContainer.style.display = 'none';
    const newFolderNameInput = document.getElementById('add-new-folder-name');
    if (newFolderNameInput) newFolderNameInput.value = '';
    
    // Reset color swatches to default
    document.querySelectorAll('#add-modal .color-swatch').forEach(swatch => {
      if (swatch.dataset.color === 'default') {
        swatch.classList.add('active');
      } else {
        swatch.classList.remove('active');
      }
    });
  } else if (modalId === 'folder-modal') {
    document.getElementById('folder-name-input').focus();
  }
}

function closeModal(modalId) {
  document.getElementById(modalId).setAttribute('hidden', 'true');
  const openModals = document.querySelectorAll('.modal:not([hidden])');
  if (openModals.length === 0) {
    document.body.classList.remove('modal-open');
  }
}

let confirmResolver = null;

function showConfirm(title, message, confirmBtnText = 'Confirm', cancelBtnText = 'Cancel') {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').innerHTML = message;
    
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    if (okBtn) okBtn.textContent = confirmBtnText;
    
    if (cancelBtn) {
      if (cancelBtnText) {
        cancelBtn.style.display = '';
        cancelBtn.textContent = cancelBtnText;
      } else {
        cancelBtn.style.display = 'none';
      }
    }
    
    openModal('confirm-modal');
  });
}

window.closeConfirmModal = function(result) {
  closeModal('confirm-modal');
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
};

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    } else {
      sidebar.classList.add('open');
      overlay.classList.add('open');
    }
  }
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.setAttribute('hidden', 'true'));
  document.body.classList.remove('modal-open');
}

// --- Google Drive API Integration ---
async function verifyAndFetchData() {
  // Load cached files & folders immediately to avoid blank screens
  loadCachedData();
  renderGrid();
  renderSidebarFolders();

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
    googleUserId = profile.sub || null;
    if (userEmail) {
      safeStorage.setItem('mymind_user_email', userEmail);
    }
    if (googleUserId) {
      safeStorage.setItem('mymind_google_user_id', googleUserId);
    }
    document.getElementById('user-avatar').src = profile.picture || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp';
    document.getElementById('user-name').textContent = profile.name || 'Personal Mind';

    showAppPage();

    // Start background sync without blocking the UI
    loadFolders().then(() => {
      return Promise.all([
        loadSettingsFromDrive(),
        loadMindItems()
      ]);
    }).then(() => {
      checkOnboarding();
    }).catch(syncErr => {
      console.error('Initial background sync failed:', syncErr);
      setSyncStatus('synced', 'Sync Failed');
    });

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
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='folders.json' and mimeType='application/json'&fields=files(id, name, modifiedTime)`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!res.ok) {
      throw new Error(`Failed to list folders from Google Drive: ${res.status}`);
    }
    
    const data = await res.json();
    
    if (data.files && data.files.length > 0) {
      const file = data.files[0];
      const cachedFoldersTime = safeStorage.getItem('folders_modified_time');
      
      // If folders.json modifiedTime matches our cache, use cached folders
      if (cachedFoldersTime === file.modifiedTime && folders && folders.length > 0) {
        console.log('Folders cache is up-to-date.');
      } else {
        const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!contentRes.ok) {
          throw new Error(`Failed to get folders content: ${contentRes.status}`);
        }
        folders = await contentRes.json();
        saveFoldersCache();
        safeStorage.setItem('folders_modified_time', file.modifiedTime);
      }
      safeStorage.setItem('folders_file_id', file.id);
      renderSidebarFolders();
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
      if (!createRes.ok) {
        throw new Error(`Failed to create folders.json on Google Drive: ${createRes.status}`);
      }
      const newFile = await createRes.json();
      safeStorage.setItem('folders_file_id', newFile.id);
      
      // Upload empty list content
      await uploadFileContent(newFile.id, []);
      saveFoldersCache();
      renderSidebarFolders();
    }
    renderGrid();
    renderSidebarFolders();
    runBackgroundEmbeddingIndexing();
  } catch (err) {
    console.error('Failed to load/create folders.json:', err);
    throw err;
  }
}

async function loadMindItems() {
  setSyncStatus('syncing', 'Syncing your Mind...');
  try {
    let remoteFiles = [];
    let pageToken = '';
    
    do {
      const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name != 'folders.json' and mimeType='application/json' and trashed=false&fields=nextPageToken,files(id, name, modifiedTime)&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!res.ok) {
        throw new Error(`Failed to list files from Google Drive: ${res.status}`);
      }
      
      const data = await res.json();
      if (data.files) {
        remoteFiles = remoteFiles.concat(data.files);
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    
    if (remoteFiles.length > 0) {
      const remoteFileIds = new Set(remoteFiles.map(f => f.id));
      
      // Filter out cached files that are no longer present on Google Drive (deleted)
      const existingCache = driveFiles.filter(item => remoteFileIds.has(item._drive_file_id));
      
      // Download or resolve contents of each JSON file in parallel
      const fetchPromises = remoteFiles.map(async (file) => {
        // Look for a cached item with matching ID and modified time
        const cached = existingCache.find(item => item._drive_file_id === file.id);
        if (cached && cached._drive_modified_time === file.modifiedTime) {
          return cached; // Return cached item directly (0 network cost!)
        }
        
        // Otherwise fetch the updated/new content from Drive
        try {
          const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          if (!contentRes.ok) {
            throw new Error(`Failed to get file content: ${contentRes.status}`);
          }
          const textData = await contentRes.text();
          if (!textData.trim()) {
            throw new SyntaxError('Empty response');
          }
          const item = JSON.parse(textData);
          item._drive_file_id = file.id;
          item._drive_modified_time = file.modifiedTime;
          if (item.type === 'color' || item.type === 'quote') {
            item.type = 'note';
          }
          return sanitizeMindItem(item);
        } catch (e) {
          console.error(`Error loading file content for ${file.name}:`, e);
          
          // Auto-cleanup: If the file was successfully downloaded but is corrupt/empty, delete it from Google Drive
          if (e instanceof SyntaxError) {
            console.warn(`Auto-deleting corrupt/empty file from Google Drive: ${file.name} (ID: ${file.id})`);
            fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${accessToken}` }
            }).catch(delErr => console.error('Failed to auto-delete corrupt file:', delErr));
          }
          
          return cached || null;
        }
      });
      
      const loaded = await Promise.all(fetchPromises);
      
      // Preserve any local placeholder items that were added after/during the fetch
      const currentPlaceholders = driveFiles.filter(item => item.isPlaceholder);
      
      // Preserve any recently saved local items that might not have been in the fetched remote files list yet
      const remoteIds = new Set(loaded.filter(x => x !== null).map(x => x.id));
      const newlySavedItems = driveFiles.filter(item => !item.isPlaceholder && !remoteIds.has(item.id) && item._is_newly_saved);
      
      driveFiles = [...currentPlaceholders, ...newlySavedItems, ...loaded.filter(x => x !== null)];
      
      // Sort drive files by creation date (newest first)
      driveFiles.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      // Update local storage cache
      saveFilesCache();
      
      // Trigger background metadata enrichment (detailed summaries and increased tags)
      runBackgroundMetadataEnrichment();
      runBackgroundEmbeddingIndexing();
    } else {
      driveFiles = [];
      saveFilesCache();
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
  if (!fileId) {
    throw new Error('Google Drive upload requires a valid fileId');
  }
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(jsonContent)
  });
  if (!res.ok) {
    throw new Error(`Failed to upload file content to Google Drive: ${res.status}`);
  }
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
    saveFoldersCache();
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
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="folder-count">${count}</span>
        <span class="btn-delete-folder" title="Delete Folder">&times;</span>
      </div>
    `;

    navItem.addEventListener('click', (e) => {
      document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
      navItem.classList.add('active');
      currentFilter = navItem.dataset.filter;
      renderGrid();
      closeMobileSidebar();
    });

    const btnDelete = navItem.querySelector('.btn-delete-folder');
    if (btnDelete) {
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation(); // Avoid triggering navigation filter click
        confirmDeleteFolder(folder.id, folder.name);
      });
    }

    container.appendChild(navItem);
  });
}

async function confirmDeleteFolder(folderId, folderName) {
  const confirmed = await showConfirm(
    'Delete Folder',
    `Are you sure you want to delete the folder "${folderName}"? All notes inside will be moved to your Inbox.`,
    'Delete',
    'Cancel'
  );
  if (confirmed) {
    deleteFolder(folderId, folderName);
  }
}

async function deleteFolder(folderId, folderName) {
  setSyncStatus('syncing', 'Deleting Folder...');
  
  // 1. Remove folder from global folders list
  folders = folders.filter(f => f.id !== folderId);
  
  // 2. Remove folder reference from files
  let itemsToUpdate = [];
  driveFiles.forEach(item => {
    if (item.folders && item.folders.includes(folderId)) {
      item.folders = item.folders.filter(fid => fid !== folderId);
      itemsToUpdate.push(item);
    }
  });

  // 3. Reset filter if the currently selected filter is this folder
  if (currentFilter === 'folder-' + folderId) {
    currentFilter = 'all';
    const allBtn = document.getElementById('filter-all');
    if (allBtn) {
      document.querySelectorAll('.sidebar-nav .nav-item, .folder-nav-item').forEach(el => el.classList.remove('active'));
      allBtn.classList.add('active');
    }
  }

  saveFoldersCache();
  renderSidebarFolders();
  renderGrid();

  try {
    // 4. Upload updated folders list to Google Drive
    const foldersFileId = safeStorage.getItem('folders_file_id');
    await uploadFileContent(foldersFileId, folders);
    
    // 5. Upload updated files to Google Drive in the background
    for (const item of itemsToUpdate) {
      await uploadFileContent(item._drive_file_id, item);
    }
    saveFilesCache();

    showToast(`Deleted folder "${folderName}". Items moved to Inbox.`);
    setSyncStatus('synced', 'Synced');
  } catch (err) {
    console.error('Failed to sync folder deletion to Google Drive:', err);
    showToast('Failed to sync deletion to Google Drive.');
    setSyncStatus('synced', 'Sync Failed');
  }
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

  const newFolderOpt = document.createElement('option');
  newFolderOpt.value = '__NEW_FOLDER__';
  newFolderOpt.textContent = '➕ Create new folder...';
  select.appendChild(newFolderOpt);
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

  const model = 'gemma-4-31b-it';
  
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
      } catch (innerErr) {
        // Fall back to original error
      }
    }
    throw e;
  }
}

function formatCardDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatLocalISO(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function resetAISearch() {
  aiFilteredIds = null;
  if (aiSearchAbortController) {
    aiSearchAbortController.abort();
    aiSearchAbortController = null;
  }
  const container = document.querySelector('.search-container');
  if (container) container.classList.remove('ai-searching');
  const loader = document.getElementById('search-loader');
  if (loader) loader.setAttribute('hidden', 'true');
}

async function executeAISearch(query) {
  if (aiSearchAbortController) {
    aiSearchAbortController.abort();
  }
  aiSearchAbortController = new AbortController();
  const { signal } = aiSearchAbortController;

  let apiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  const email = userEmail || safeStorage.getItem('mymind_user_email');
  const isChakshu = email === 'chakshu.grover8@gmail.com';

  if (!apiKey && !isChakshu) {
    showToast('AI search requires a Gemini API Key. Please add one in Settings. Falling back to keyword search.');
    aiFilteredIds = null;
    const container = document.querySelector('.search-container');
    if (container) container.classList.remove('ai-searching');
    const loader = document.getElementById('search-loader');
    if (loader) loader.setAttribute('hidden', 'true');
    renderGrid();
    return;
  }

  const model = 'gemini-3.1-flash-lite';
  const loadedFiles = driveFiles.filter(item => !item.isPlaceholder);
  if (loadedFiles.length === 0) {
    aiFilteredIds = [];
    renderGrid();
    return;
  }

  const notesIndex = loadedFiles.map(item => {
    return {
      id: item.id,
      title: item.title || 'Untitled',
      type: item.type || 'note',
      created_at: formatLocalISO(item.created_at),
      summary: item.ai_analysis?.summary || '',
      tags: item.ai_analysis?.tags || [],
      vibe: item.ai_analysis?.vibe || '',
      content: (item.content?.raw_text || '').substring(0, 300)
    };
  });

  const systemInstruction = `
    You are a highly advanced AI search engine running inside "MyMindSpace", a personal canvas for notes, articles/links, to-dos, and colors.
    Your task is to match the user's natural language search query against their stored items.
    
    Today's Date and Time is: ${formatLocalISO(new Date())} (local time).
    User Search Query: "${query}"
    
    Rules for matching:
    1. Understand conceptual connections: e.g., "claude" matches "anthropic", "llm", "ai model".
    2. Understand relative time queries: compare phrases like "last week", "yesterday", "three days ago" to the "created_at" timestamps.
    3. Understand item type queries: if the query specifies "articles", "notes", "todos", or "colors", restrict your top matches to those types.
    4. If the query is a simple color description (e.g. "blue color", "calming tones"), match relevant vibes or color tags.
    5. Return a ranked list of matches, ordered from most relevant to least relevant.
    
    Below is the JSON list of stored items:
    ${JSON.stringify(notesIndex)}
    
    CRITICAL: If no items match the query or the date criteria (for example, if the query asks for "articles from yesterday" but there are no articles from yesterday in the index), you must return an empty JSON array []. Do not return other items.
    
    Respond STRICTLY in a JSON array of matching item IDs. Example format:
    ["item-12345-abcde", "item-67890-fghij"]
    Do not output markdown codeblocks, explanations, or any other content. Only output the JSON array.
  `;

  try {
    const endpoint = `/api/gemini?model=${model}&key=${apiKey}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: systemInstruction }]
        }
      ]
    };
    
    payload.generationConfig = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        description: 'List of matching item IDs, ordered by relevance',
        items: {
          type: 'STRING'
        }
      }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) throw new Error('Gemini API search request failed');

    const responseData = await response.json();
    const parts = responseData.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => !p.thought) || parts[0] || { text: '' };
    const rawText = textPart.text || '';
    
    let parsedIDs = [];
    try {
      parsedIDs = cleanAndParseJSON(rawText);
      if (!Array.isArray(parsedIDs)) {
        parsedIDs = [];
      }
    } catch (e) {
      console.error('Failed to parse AI search results:', e, rawText);
    }

    aiFilteredIds = parsedIDs;

    const container = document.querySelector('.search-container');
    if (container) container.classList.remove('ai-searching');
    const loader = document.getElementById('search-loader');
    if (loader) loader.setAttribute('hidden', 'true');

    renderGrid();

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Search aborted due to new input');
      return;
    }
    console.error('AI search failed:', err);
    showToast('AI search failed. Falling back to keyword search.');
    aiFilteredIds = null;
    const container = document.querySelector('.search-container');
    if (container) container.classList.remove('ai-searching');
    const loader = document.getElementById('search-loader');
    if (loader) loader.setAttribute('hidden', 'true');
    renderGrid();
  }
}

async function enrichMetadataWithAI(item) {
  let apiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  const email = userEmail || safeStorage.getItem('mymind_user_email');
  const isChakshu = email === 'chakshu.grover8@gmail.com';
  if (!apiKey && !isChakshu) return null;

  const prompt = `
    Analyze the following item and perform three tasks:
    1. Generate a list of 8 to 15 highly descriptive tags that represent its topics, concepts, entities, and categories for semantic search indexing. (Do not use hashtags. Respond with simple lowercase words).
    2. Generate a concise, abstract summary (1 to 2 sentences) of the item. For quotes, write a beautiful reflection. For colors, describe the mood.
    3. Generate a much larger, detailed, and comprehensive summary paragraph (3 to 6 sentences) summarizing the core concepts, main context, and key details of the item. For quotes, write a rich reflection. For colors, write an evocative description of the vibe.

    Type: ${item.type || 'note'}
    Title: ${item.title || ''}
    URL: ${item.url || ''}
    Content: ${item.content?.raw_text || ''}

    Respond STRICTLY in a JSON object with this schema:
    {
      "tags": ["tag1", "tag2", ...],
      "summary": "Your concise 1-2 sentence summary here",
      "detailed_summary": "Your detailed 3-6 sentence summary here"
    }
  `;

  try {
    const response = await fetch(`/api/gemini?model=gemma-4-31b-it&key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              tags: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              },
              summary: { type: 'STRING' },
              detailed_summary: { type: 'STRING' }
            },
            required: ['tags', 'summary', 'detailed_summary']
          }
        }
      })
    });
    if (!response.ok) return null;
    const responseData = await response.json();
    const parts = responseData.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => !p.thought) || parts[0] || { text: '' };
    const rawText = textPart.text || '';
    const result = cleanAndParseJSON(rawText);
    if (result && Array.isArray(result.tags) && typeof result.summary === 'string' && typeof result.detailed_summary === 'string') {
      return result;
    }
    return null;
  } catch (e) {
    console.error('Metadata enrichment error:', e);
    return null;
  }
}

async function runBackgroundMetadataEnrichment() {
  if (safeStorage.getItem('mymind_metadata_enriched_v3') === 'true') {
    return;
  }
  if (!accessToken) return;

  const itemsToEnrich = driveFiles.filter(item => !item.isPlaceholder && !item.metadata_enriched_v3);
  if (itemsToEnrich.length === 0) {
    safeStorage.setItem('mymind_metadata_enriched_v3', 'true');
    return;
  }

  console.log(`Starting background metadata enrichment (detailed summary & 8-15 tags) for ${itemsToEnrich.length} items...`);
  
  for (const item of itemsToEnrich) {
    try {
      const enriched = await enrichMetadataWithAI(item);
      if (enriched) {
        const uniqueTags = Array.from(new Set([...(item.ai_analysis?.tags || []), ...(enriched.tags || [])]));
        if (!item.ai_analysis) item.ai_analysis = {};
        item.ai_analysis.tags = uniqueTags;
        item.ai_analysis.summary = enriched.summary || item.ai_analysis.summary;
        item.ai_analysis.detailed_summary = enriched.detailed_summary;
        item.metadata_enriched_v3 = true;

        if (item._drive_file_id) {
          await uploadFileContent(item._drive_file_id, item);
        }
      } else {
        item.metadata_enriched_v3 = true;
      }
    } catch (e) {
      console.error(`Failed to enrich metadata for item ${item.id}:`, e);
      item.metadata_enriched_v3 = true;
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }

  safeStorage.setItem('mymind_metadata_enriched_v3', 'true');
  saveFilesCache();
  console.log('Background metadata enrichment complete!');
  renderGrid();
}

// Markdown parser with marked.js and fallback regex parser
function renderMarkdown(text) {
  if (!text) return '';
  
  if (window.marked) {
    try {
      const parseFn = typeof window.marked.parse === 'function' ? window.marked.parse : (typeof window.marked === 'function' ? window.marked : null);
      if (parseFn) {
        return parseFn(text, {
          gfm: true,
          breaks: true
        });
      }
    } catch (e) {
      console.error('Failed to parse markdown with marked.js, falling back:', e);
    }
  }
  
  // Robust fallback regex parser
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
    
  escaped = escaped.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  escaped = escaped.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  escaped = escaped.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/__(.*?)__/g, '<strong>$1</strong>');
  escaped = escaped.replace(/_(.*?)_/g, '<em>$1</em>');
  escaped = escaped.replace(/`(.*?)`/g, '<code>$1</code>');
  escaped = escaped.replace(/^\s*[-*]\s+(.*$)/gim, '<li>$1</li>');
  escaped = escaped.replace(/^\s*&gt;\s+(.*$)/gim, '<blockquote>$1</blockquote>');
  escaped = escaped.replace(/\n/g, '<br>');
  
  return escaped;
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
  const todoToggle = document.getElementById('add-todo-toggle');
  const newFolderInput = document.getElementById('add-new-folder-name');
  
  const titleInput = document.getElementById('add-title-input');
  
  const rawInputText = addInput.value.trim();
  const customTitle = titleInput ? titleInput.value.trim() : '';
  let folderId = folderSelect.value;
  const isTodo = todoToggle ? todoToggle.checked : false;

  // Handle creating new folder inline
  if (folderId === '__NEW_FOLDER__') {
    const newFolderName = newFolderInput ? newFolderInput.value.trim() : '';
    if (!newFolderName) {
      showToast('New folder name cannot be empty.');
      return;
    }
    
    // Create new folder object locally
    const newFolderId = 'folder-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    const newFolder = {
      id: newFolderId,
      name: newFolderName,
      emoji: '📁',
      color: '#a855f7', // Default soft purple
      created_at: new Date().toISOString()
    };
    
    folders.push(newFolder);
    saveFoldersCache();
    renderSidebarFolders();
    
    // Sync folder in background
    uploadFileContent(safeStorage.getItem('folders_file_id'), folders).then(() => {
      console.log(`Inline folder "${newFolderName}" synced to Drive.`);
    }).catch(err => {
      console.error('Failed to sync inline folder to Google Drive:', err);
    });

    folderId = newFolderId; // Use the new folder for the item

    // If note text input is empty, just create the folder and return
    if (!rawInputText) {
      if (newFolderInput) newFolderInput.value = '';
      if (titleInput) titleInput.value = '';
      closeModal('add-modal');
      showToast(`Created folder "${newFolderName}"`);
      return;
    }
  }

  if (!rawInputText) {
    showToast('Input cannot be empty.');
    return;
  }

  // Read selected color from Quick Add swatches
  const activeSwatch = document.querySelector('#add-modal .color-swatch.active');
  const selectedColor = activeSwatch ? activeSwatch.dataset.color : 'default';

  // Close modal and reset input immediately!
  addInput.value = '';
  if (titleInput) titleInput.value = '';
  if (todoToggle) todoToggle.checked = false;
  if (newFolderInput) newFolderInput.value = '';
  closeModal('add-modal');
  showToast('Adding to your Mind...');

  // Create placeholder item
  const placeholderId = 'item-temp-' + Date.now();
  const placeholderItem = {
    id: placeholderId,
    created_at: new Date().toISOString(),
    type: isTodo ? 'todo' : 'note',
    title: customTitle || 'Processing...',
    folders: folderId ? [folderId] : [],
    color: selectedColor,
    pinned: false,
    isPlaceholder: true,
    content: { raw_text: rawInputText }
  };

  // Add to local list and render visual grid immediately
  driveFiles.unshift(placeholderItem);
  renderGrid();

  // Run the background save asynchronously
  runBackgroundSave(placeholderId, rawInputText, folderId, activeAddType, selectedColor, customTitle);
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

function extractAndCleanUrl(text) {
  if (!text) return null;
  let cleaned = text.trim();
  
  // If the text starts with http/https/www, let's see if it's a URL split by newlines/spaces
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.startsWith('www.')) {
    // Remove all whitespace/newlines to reconstruct the URL if it was wrapped
    const potentialUrl = cleaned.replace(/[\s\r\n]+/g, '');
    try {
      // Validate that it looks like a valid URL
      const testUrl = potentialUrl.startsWith('www.') ? 'https://' + potentialUrl : potentialUrl;
      new URL(testUrl);
      return potentialUrl;
    } catch (e) {
      // If rejoining fails, fallback to regex search
    }
  }

  // Fallback: search for first URL in the text
  const urlRegex = /(https?:\/\/[^\s\r\n]+|www\.[^\s\r\n]+)/i;
  const match = cleaned.match(urlRegex);
  if (match) {
    let matchedUrl = match[1];
    // If there's a trailing punctuation/bracket, clean it
    matchedUrl = matchedUrl.replace(/[.,;:!?)\]]+$/, '');
    return matchedUrl;
  }
  return null;
}

async function runBackgroundSave(placeholderId, rawInputText, folderId, itemType = 'general', color = 'default', customTitle = '') {
  let pendingX = undefined;
  let pendingY = undefined;
  if (canvasPendingCoords) {
    pendingX = canvasPendingCoords.x;
    pendingY = canvasPendingCoords.y;
    canvasPendingCoords = null;
  }
  try {
    const isTodo = itemType === 'todo';
    
    // Extract and clean the URL if present (only if not a todo or note)
    const canBeUrl = itemType !== 'todo' && itemType !== 'note';
    const cleanedUrl = canBeUrl ? extractAndCleanUrl(rawInputText) : null;
    const isUrl = itemType === 'link' || (itemType === 'general' && !!cleanedUrl);
    
    let aiInputText = rawInputText;
    let scrapedImage = null;
    let scrapedTitle = null;

    if (isUrl) {
      try {
        const scrapeRes = await fetch(`/api/scrape?url=${encodeURIComponent(cleanedUrl || rawInputText)}`);
        if (scrapeRes.ok) {
          const meta = await scrapeRes.json();
          scrapedImage = meta.image;
          scrapedTitle = meta.title;
          aiInputText = `Webpage URL: ${cleanedUrl || rawInputText}\nTitle: ${meta.title}\nDescription: ${meta.description}`;
        }
      } catch (e) {
        console.error('Failed to scrape URL metadata in background:', e);
      }
    }

    // 1. Run Gemma 4 31B / Gemini 3.1 Cloud analysis (Only run for links or general URL entries)
    let aiParsed = null;
    const runAI = itemType === 'link' || (itemType === 'general' && isUrl);
    if (runAI) {
      aiParsed = await analyzeInputWithAI(aiInputText);
    }
    
    // 2. Build full metadata object
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      created_at: new Date().toISOString(),
      type: isTodo ? 'todo' : (isUrl ? 'article' : 'note'),
      title: customTitle || (isTodo ? (rawInputText.split('\n')[0].trim().substring(0, 40) || 'To-Do List') : (isUrl ? (aiParsed ? (aiParsed.title || 'Saved Item') : scrapedTitle || 'Saved Item') : (rawInputText.split('\n')[0].trim().substring(0, 40) || 'Saved Note'))),
      folders: folderId ? [folderId] : [],
      color: color,
      pinned: false,
      canvas_x: pendingX,
      canvas_y: pendingY,
      url: isUrl ? (cleanedUrl || rawInputText) : '',
      image: scrapedImage || '',
      ai_analysis: (aiParsed && aiParsed.ai_analysis) || {
        summary: isTodo ? 'To-Do Checklist' : (isUrl ? 'Web Article' : 'Handwritten Note'),
        tags: isTodo ? ['todo'] : (isUrl ? ['link', 'web'] : ['note']),
        vibe: 'clean',
        key_takeaways: []
      },
      content: {
        raw_text: (isTodo || !isUrl) ? rawInputText : ((aiParsed && aiParsed.content && aiParsed.content.raw_text) || rawInputText),
        word_count: rawInputText.split(/\s+/).length,
        reading_time_mins: Math.max(1, Math.ceil(rawInputText.split(/\s+/).length / 200))
      }
    };

    // If it's a todo, parse lines into todo list
    if (isTodo) {
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

    // Map color/quote to note
    if (newItem.type === 'color' || newItem.type === 'quote') {
      newItem.type = 'note';
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
    
    if (!createRes.ok) {
      throw new Error(`Failed to create file on Google Drive: ${createRes.status}`);
    }
    const driveFile = await createRes.json();
    if (!driveFile.id) {
      throw new Error('Google Drive file creation did not return an ID');
    }
    
    // 4. Upload contents
    await uploadFileContent(driveFile.id, newItem);

    // Replace placeholder with final item
    newItem._drive_file_id = driveFile.id;
    newItem._is_newly_saved = true;
    const index = driveFiles.findIndex(item => item.id === placeholderId);
    if (index !== -1) {
      driveFiles[index] = newItem;
    } else {
      driveFiles.unshift(newItem);
    }
    saveFilesCache();

    showToast('Saved to your Mind!');
    setSyncStatus('synced', 'Synced');
    
    renderGrid();
    renderSidebarFolders(); // Update counts
  } catch (err) {
    console.error('Background save failed:', err);
    showToast('AI analysis failed. Using fallback.');

    // Fallback to local mock analysis
    const cleanedUrl = !isTodo ? extractAndCleanUrl(rawInputText) : null;
    const fallback = mockAnalysis(cleanedUrl || rawInputText);
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      created_at: new Date().toISOString(),
      type: isTodo ? 'todo' : fallback.type,
      title: isTodo ? (rawInputText.split('\n')[0].trim().substring(0, 40) || 'To-Do List') : fallback.title,
      folders: folderId ? [folderId] : [],
      color: color,
      pinned: false,
      canvas_x: pendingX,
      canvas_y: pendingY,
      url: (!isTodo && fallback.type === 'article') ? (cleanedUrl || rawInputText) : '',
      ai_analysis: fallback.ai_analysis,
      content: {
        raw_text: rawInputText,
        word_count: rawInputText.split(/\s+/).length,
        reading_time_mins: Math.max(1, Math.ceil(rawInputText.split(/\s+/).length / 200))
      }
    };

    if (isTodo) {
      const lines = rawInputText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      newItem.content.todos = lines.map(line => ({
        text: line,
        completed: false
      }));
      newItem.ai_analysis.summary = 'To-Do Checklist';
      newItem.ai_analysis.tags = ['todo'];
    }

    if (newItem.type === 'color' || newItem.type === 'quote') {
      newItem.type = 'note';
    }

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
      if (!createRes.ok) {
        throw new Error(`Failed to create fallback file on Google Drive: ${createRes.status}`);
      }
      const driveFile = await createRes.json();
      if (!driveFile.id) {
        throw new Error('Google Drive fallback file creation did not return an ID');
      }
      await uploadFileContent(driveFile.id, newItem);
      newItem._drive_file_id = driveFile.id;
      newItem._is_newly_saved = true;

      // Replace placeholder
      const index = driveFiles.findIndex(item => item.id === placeholderId);
      if (index !== -1) {
        driveFiles[index] = newItem;
      } else {
        driveFiles.unshift(newItem);
      }
      saveFilesCache();
      setSyncStatus('synced', 'Synced');
    } catch (saveErr) {
      console.error('Fallback save failed:', saveErr);
      // Remove placeholder entirely if both failed
      driveFiles = driveFiles.filter(item => item.id !== placeholderId);
      saveFilesCache();
      showToast('Failed to save to Google Drive.');
      setSyncStatus('synced', 'Sync Failed');
      
      // If error looks like an authentication failure (e.g. 401), trigger token check
      if (saveErr.message.includes('401') || saveErr.message.includes('auth') || !accessToken) {
        ensureValidToken(() => {});
      }
    }

    renderGrid();
    renderSidebarFolders();
  }
}

async function deleteItem(itemId, driveFileId) {
  const confirmed = await showConfirm(
    'Forget Item',
    'Are you sure you want to forget this from your mind?',
    'Forget',
    'Cancel'
  );
  if (!confirmed) return;

  closeModal('detail-modal');
  setSyncStatus('syncing', 'Deleting...');

  ensureValidToken(async () => {
    try {
      if (driveFileId) {
        // Delete file from Google Drive
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!res.ok && res.status !== 404 && res.status !== 410) {
          throw new Error(`Failed to delete file from Google Drive: ${res.status}`);
        }
      }

      // Remove locally
      driveFiles = driveFiles.filter(item => item.id !== itemId);
      saveFilesCache();
      
      // Clean up local RAG chunks in IndexedDB
      MindDB.deleteChunks(itemId).catch(e => console.error('Failed to delete chunks on item deletion:', e));
      
      showToast('Forgotten.');
      setSyncStatus('synced', 'Synced');
      renderGrid();
      renderSidebarFolders(); // Update counts
    } catch (err) {
      console.error('Failed to delete item:', err);
      showToast('Failed to delete from Google Drive.');
      setSyncStatus('synced', 'Sync Failed');
    }
  });
}

function renderGrid() {
  const grid = document.getElementById('mind-grid');
  const emptyState = document.getElementById('empty-state');

  // Sanitize all items to ensure all nested properties exist
  driveFiles.forEach(sanitizeMindItem);

  grid.innerHTML = '';
  
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  
  // Filter items based on current view/folder and search text
  let filteredItems;
  if (query && aiFilteredIds !== null) {
    filteredItems = aiFilteredIds
      .map(id => driveFiles.find(item => item.id === id))
      .filter(Boolean);
      
    filteredItems = filteredItems.filter(item => {
      if (item.isPlaceholder) return true;
      if (currentFilter.startsWith('folder-')) {
        const folderId = currentFilter.substring(7);
        if (!item.folders || !item.folders.includes(folderId)) return false;
      } else if (currentFilter === 'type-article' && item.type !== 'article') return false;
      else if (currentFilter === 'type-note' && item.type !== 'note') return false;
      else if (currentFilter === 'type-todo' && item.type !== 'todo') return false;
      return true;
    });
  } else {
    filteredItems = driveFiles.filter(item => {
      if (item.isPlaceholder) return true;
      if (currentFilter.startsWith('folder-')) {
        const folderId = currentFilter.substring(7);
        if (!item.folders || !item.folders.includes(folderId)) return false;
      } else if (currentFilter === 'type-article' && item.type !== 'article') return false;
      else if (currentFilter === 'type-note' && item.type !== 'note') return false;
      else if (currentFilter === 'type-todo' && item.type !== 'todo') return false;

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
  }

  const pinnedSection = document.getElementById('pinned-section');
  const pinnedGrid = document.getElementById('pinned-grid');
  const othersTitle = document.getElementById('others-title');
  const othersSection = document.getElementById('others-section');

  if (currentViewMode === 'spatial') {
    if (pinnedSection) pinnedSection.setAttribute('hidden', 'true');
    if (othersSection) othersSection.setAttribute('hidden', 'true');
    if (othersTitle) othersTitle.setAttribute('hidden', 'true');
    grid.style.display = 'none';
    
    const spatialView = document.getElementById('spatial-canvas-view');
    if (spatialView) {
      spatialView.removeAttribute('hidden');
      if (filteredItems.length === 0) {
        emptyState.removeAttribute('hidden');
        document.getElementById('spatial-canvas-viewport').style.display = 'none';
      } else {
        emptyState.setAttribute('hidden', 'true');
        document.getElementById('spatial-canvas-viewport').style.display = 'block';
        renderSpatialCanvas(filteredItems);
        startPhysicsSimulation(filteredItems);
      }
    }
    return;
  } else {
    stopPhysicsSimulation();
    const spatialView = document.getElementById('spatial-canvas-view');
    if (spatialView) spatialView.setAttribute('hidden', 'true');
    if (othersSection) othersSection.removeAttribute('hidden');
  }

  if (pinnedGrid) pinnedGrid.innerHTML = '';

  if (filteredItems.length === 0) {
    emptyState.removeAttribute('hidden');
    if (pinnedSection) pinnedSection.setAttribute('hidden', 'true');
    if (othersTitle) othersTitle.setAttribute('hidden', 'true');
    grid.style.display = 'none';
  } else {
    emptyState.setAttribute('hidden', 'true');
    grid.style.display = 'grid';

    const pinnedItems = filteredItems.filter(item => item.pinned && !item.isPlaceholder);
    const othersItems = filteredItems.filter(item => !item.pinned || item.isPlaceholder);

    if (pinnedItems.length > 0) {
      if (pinnedSection) pinnedSection.removeAttribute('hidden');
      if (othersTitle) othersTitle.removeAttribute('hidden');
    } else {
      if (pinnedSection) pinnedSection.setAttribute('hidden', 'true');
      if (othersTitle) othersTitle.setAttribute('hidden', 'true');
    }

    const renderCard = (item, targetGrid) => {
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
        targetGrid.appendChild(card);
        return;
      }

      card.className = `mind-card mind-card--${item.type} color-${item.color || 'default'}`;

      // Card rendering template based on types
      if (item.type === 'todo') {
        const todos = item.content.todos || [];
        const visibleTodos = todos.slice(0, 5);
        const remainingCount = todos.length - visibleTodos.length;
        
        const todoListHtml = visibleTodos.map((todo, idx) => `
          <label class="card-todo-item" style="display: flex; align-items: flex-start; gap: 8px; font-size: 0.9rem; margin-block-end: 6px; cursor: pointer; pointer-events: auto;">
            <input type="checkbox" class="card-todo-checkbox" data-item-id="${item.id}" data-todo-index="${idx}" ${todo.completed ? 'checked' : ''} style="margin-block-start: 3px;" />
            <span class="card-todo-text" style="text-decoration: ${todo.completed ? 'line-through' : 'none'}; color: ${todo.completed ? 'var(--text-muted)' : 'var(--text-primary)'};">${todo.text}</span>
          </label>
        `).join('');

        card.innerHTML = `
          <div class="card-note-title" style="margin-block-end: 12px; padding-inline-end: 28px;">${item.title}</div>
          <div class="card-todo-list" style="margin-block-end: 12px; pointer-events: auto;">
            ${todoListHtml || '<div style="color: var(--text-muted); font-style: italic;">Empty list</div>'}
            ${remainingCount > 0 ? `<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic; margin-inline-start: 22px; margin-block-start: 4px;">+ ${remainingCount} more tasks</div>` : ''}
          </div>
          <div class="card-meta">
            <span class="card-date" style="margin-inline-start: auto;">${formatCardDate(item.created_at)}</span>
          </div>
        `;
      }
      else if (item.type === 'article') {
        const thumbImg = item.image ? `<img class="card-article-thumb" src="${item.image}" alt="${item.title}" onerror="this.style.display='none';" />` : '';
        card.innerHTML = `
          ${thumbImg}
          <div class="card-article-content">
            <div class="card-article-source" style="padding-inline-end: 28px;">${item.title}</div>
            <div class="card-article-title">${item.ai_analysis.detailed_summary || item.ai_analysis.summary}</div>
            <div class="card-meta">
              <span class="card-date" style="margin-inline-start: auto;">${formatCardDate(item.created_at)}</span>
            </div>
          </div>
        `;
      } 
      else { // note
        card.innerHTML = `
          <div class="card-note-title" style="padding-inline-end: 28px;">${item.title}</div>
          <div class="card-note-desc">${item.ai_analysis.detailed_summary || item.ai_analysis.summary}</div>
          <div class="card-meta">
            <span class="card-date" style="margin-inline-start: auto;">${formatCardDate(item.created_at)}</span>
          </div>
        `;
      }

      // Add Pin/Unpin button to card
      const pinBtn = document.createElement('button');
      pinBtn.className = `card-pin-btn ${item.pinned ? 'is-pinned' : ''}`;
      pinBtn.title = item.pinned ? 'Unpin note' : 'Pin note';
      pinBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="${item.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="17" x2="12" y2="22"></line>
          <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.26V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.26a2 2 0 0 1-.78 1.24l-2.78 3.5a2 2 0 0 0-.44 1.24z"></path>
        </svg>
      `;
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(item);
      });
      card.appendChild(pinBtn);

      // Add click to open Detail Modal
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('card-todo-checkbox') || e.target.closest('.card-pin-btn')) {
          return;
        }
        showDetailModal(item);
      });

      // Bind checkbox change handlers inside card
      card.querySelectorAll('.card-todo-checkbox').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const idx = parseInt(e.target.dataset.todoIndex, 10);
          if (!item.content.todos) item.content.todos = [];
          item.content.todos[idx].completed = cb.checked;
          
          const textEl = cb.nextElementSibling;
          if (textEl) {
            textEl.style.textDecoration = cb.checked ? 'line-through' : 'none';
            textEl.style.color = cb.checked ? 'var(--text-muted)' : 'var(--text-primary)';
          }

          setSyncStatus('syncing', 'Updating task...');
          try {
            await uploadFileContent(item._drive_file_id, item);
            saveFilesCache();
            setSyncStatus('synced', 'Synced');
          } catch (err) {
            console.error('Failed to update task state on Drive:', err);
            showToast('Sync failed.');
            setSyncStatus('synced', 'Sync Failed');
          }
        });
      });

      targetGrid.appendChild(card);
    };

    pinnedItems.forEach(item => renderCard(item, pinnedGrid));
    othersItems.forEach(item => renderCard(item, grid));
  }
}

async function togglePin(item) {
  item.pinned = !item.pinned;
  
  // Re-render locally for instant visual feedback
  renderGrid();
  
  setSyncStatus('syncing', 'Updating pin status...');
  try {
    await uploadFileContent(item._drive_file_id, item);
    saveFilesCache();
    setSyncStatus('synced', 'Synced');
  } catch (err) {
    console.error('Failed to update pin status on Drive:', err);
    showToast('Sync failed.');
    setSyncStatus('synced', 'Sync Failed');
    
    // Rollback local state
    item.pinned = !item.pinned;
    renderGrid();
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
  document.getElementById('detail-date').textContent = formatCardDate(item.created_at);

  currentDetailItem = item;
  isEditingDetail = false;

  // Apply card color class to detail panel
  const panel = document.querySelector('.modal-panel--detail');
  if (panel) {
    panel.className = 'modal-panel modal-panel--detail'; // reset
    panel.classList.add(`color-${item.color || 'default'}`);
  }

  // Setup detail pin button
  const btnPin = document.getElementById('btn-detail-pin');
  if (btnPin) {
    btnPin.className = `btn-detail-action ${item.pinned ? 'is-pinned' : ''}`;
    btnPin.title = item.pinned ? 'Unpin note' : 'Pin note';
    
    const newBtnPin = btnPin.cloneNode(true);
    btnPin.parentNode.replaceChild(newBtnPin, btnPin);
    newBtnPin.addEventListener('click', async () => {
      await togglePin(item);
      newBtnPin.className = `btn-detail-action ${item.pinned ? 'is-pinned' : ''}`;
      newBtnPin.title = item.pinned ? 'Unpin note' : 'Pin note';
    });
  }

  // Handle Chat button binding
  const btnChatItem = document.getElementById('btn-chat-item');
  if (btnChatItem) {
    if (item.type === 'color') {
      btnChatItem.style.display = 'none';
    } else {
      btnChatItem.style.display = 'inline-flex';
      const newBtnChatItem = btnChatItem.cloneNode(true);
      btnChatItem.parentNode.replaceChild(newBtnChatItem, btnChatItem);
      newBtnChatItem.addEventListener('click', () => {
        closeModal('detail-modal');
        if (typeof openChatFn === 'function') {
          openChatFn(item);
        }
      });
    }
  }

  // Handle Edit button binding
  const btnEdit = document.getElementById('btn-edit-item');
  if (btnEdit) {
    const newBtnEdit = btnEdit.cloneNode(true);
    btnEdit.parentNode.replaceChild(newBtnEdit, btnEdit);
    newBtnEdit.textContent = 'Edit';
    newBtnEdit.className = 'btn btn--secondary btn--small';
    newBtnEdit.addEventListener('click', handleEditSaveClick);
  }

  // Handle deletion binding
  const btnDelete = document.getElementById('btn-delete-item');
  const newBtnDelete = btnDelete.cloneNode(true);
  btnDelete.parentNode.replaceChild(newBtnDelete, btnDelete); // Remove previous listeners
  newBtnDelete.addEventListener('click', () => deleteItem(item.id, item._drive_file_id));

  // Configure prominent open link button
  const btnOpenLink = document.getElementById('btn-open-link');
  if (btnOpenLink) {
    if (item.type === 'article' && item.url) {
      btnOpenLink.href = item.url;
      btnOpenLink.style.display = 'inline-flex';
    } else {
      btnOpenLink.style.display = 'none';
    }
  }

  // Render modal content
  if (item.type === 'todo') {
    const todos = item.content.todos || [];
    const activeTodos = todos.filter(t => !t.completed);
    const completedTodos = todos.filter(t => t.completed);

    const renderTodoRowHtml = (todo, realIdx) => `
      <label class="detail-todo-item" style="display: flex; align-items: flex-start; gap: 10px; font-size: 1.05rem; margin-block-end: 12px; cursor: pointer;">
        <input type="checkbox" class="detail-todo-checkbox" data-todo-index="${realIdx}" ${todo.completed ? 'checked' : ''} style="transform: scale(1.15); margin-block-start: 4px;" />
        <span class="detail-todo-text" style="text-decoration: ${todo.completed ? 'line-through' : 'none'}; color: ${todo.completed ? 'var(--text-muted)' : 'var(--text-primary)'};">${todo.text}</span>
      </label>
    `;

    const activeHtml = activeTodos.map(todo => {
      const realIdx = todos.indexOf(todo);
      return renderTodoRowHtml(todo, realIdx);
    }).join('');

    const completedHtml = completedTodos.map(todo => {
      const realIdx = todos.indexOf(todo);
      return renderTodoRowHtml(todo, realIdx);
    }).join('');

    contentContainer.innerHTML = `
      <div class="detail-content">
        <h2 class="detail-title" style="margin-block-end: 20px;">${item.title}</h2>
        <div class="detail-todo-list-active" style="margin-block-end: 16px;">
          ${activeHtml || '<div style="color: var(--text-muted); font-style: italic;">No active tasks.</div>'}
        </div>
        ${completedTodos.length > 0 ? `
          <div class="completed-todos-section" style="border-block-start: 1px solid var(--border-glass); padding-block-start: 16px;">
            <button type="button" id="btn-toggle-completed-list" style="display: flex; align-items: center; gap: 6px; font-size: 0.9rem; font-weight: 600; color: var(--text-secondary); cursor: pointer; margin-block-end: 12px;">
              <span id="completed-toggle-arrow">▼</span> Completed items (${completedTodos.length})
            </button>
            <div id="detail-todo-list-completed" style="margin-inline-start: 4px;">
              ${completedHtml}
            </div>
          </div>
        ` : ''}
      </div>
    `;

    // Collapsible Completed List Handler
    const btnToggleCompleted = document.getElementById('btn-toggle-completed-list');
    const completedList = document.getElementById('detail-todo-list-completed');
    const toggleArrow = document.getElementById('completed-toggle-arrow');
    if (btnToggleCompleted && completedList) {
      btnToggleCompleted.addEventListener('click', () => {
        const isHidden = completedList.style.display === 'none';
        completedList.style.display = isHidden ? 'block' : 'none';
        if (toggleArrow) {
          toggleArrow.textContent = isHidden ? '▼' : '▶';
        }
      });
    }

    // Bind change listener for detail checkboxes
    contentContainer.querySelectorAll('.detail-todo-checkbox').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const idx = parseInt(e.target.dataset.todoIndex, 10);
        if (!item.content.todos) item.content.todos = [];
        item.content.todos[idx].completed = cb.checked;

        // Re-render text style locally for instant feedback
        const textEl = cb.nextElementSibling;
        if (textEl) {
          textEl.style.textDecoration = cb.checked ? 'line-through' : 'none';
          textEl.style.color = cb.checked ? 'var(--text-muted)' : 'var(--text-primary)';
        }

        // Delay re-render slightly to show animation
        setTimeout(() => {
          showDetailModal(item);
        }, 250);

        setSyncStatus('syncing', 'Updating task...');
        try {
          await uploadFileContent(item._drive_file_id, item);
          saveFilesCache();
          setSyncStatus('synced', 'Synced');
          renderGrid(); // Sync grid card state
        } catch (err) {
          console.error('Failed to update task state on Drive:', err);
          showToast('Sync failed.');
          setSyncStatus('synced', 'Sync Failed');
        }
      });
    });
  }
  else if (item.type === 'article') {
    const detailImg = item.image ? `<img class="detail-article-image" src="${item.image}" alt="${item.title}" style="inline-size: 100%; block-size: auto; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 12px; margin-block-end: 20px;" onerror="this.style.display='none';" />` : '';
    contentContainer.innerHTML = `
      <div class="detail-content">
        ${detailImg}
        <h2 class="detail-title">${item.title}</h2>
        
        <div class="detail-summary-box">
          <div class="detail-summary-title">Abstract Summary</div>
          <p>${item.ai_analysis.summary}</p>
        </div>

        ${item.ai_analysis.detailed_summary ? `
          <div class="detail-summary-box" style="margin-block-start: 16px;">
            <div class="detail-summary-title">Detailed Summary</div>
            <p>${item.ai_analysis.detailed_summary}</p>
          </div>
        ` : ''}

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
            <div class="detail-body-text markdown-rendered">${renderMarkdown(item.content.raw_text)}</div>
          </div>
        ` : ''}
      </div>
    `;
  } 
  else { // note
    contentContainer.innerHTML = `
      <div class="detail-content">
        <h2 class="detail-title">${item.title}</h2>
        
        ${item.ai_analysis.detailed_summary ? `
          <div class="detail-summary-box" style="margin-block-end: 20px;">
            <div class="detail-summary-title">Detailed Summary</div>
            <p>${item.ai_analysis.detailed_summary}</p>
          </div>
        ` : ''}

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
          <div class="detail-body-text markdown-rendered">${renderMarkdown(item.content.raw_text)}</div>
        </div>
      </div>
    `;
  }

  openModal('detail-modal');
}

function handleEditSaveClick() {
  if (isEditingDetail) {
    saveDetailEdits();
  } else {
    enterEditMode();
  }
}

function getColorPickerHtml(selectedColor) {
  const colors = ['default', 'red', 'yellow', 'green', 'blue', 'purple', 'pink'];
  const titles = {
    default: 'Default',
    red: 'Coral Red',
    yellow: 'Amber Yellow',
    green: 'Emerald Green',
    blue: 'Teal Blue',
    purple: 'Lavender Purple',
    pink: 'Rose Pink'
  };
  const swatchesHtml = colors.map(c => `
    <button type="button" class="color-swatch color-swatch--${c} ${selectedColor === c ? 'active' : ''}" data-color="${c}" title="${titles[c]}"></button>
  `).join('');

  return `
    <div class="color-picker-container" style="margin-block-start: 20px; border-block-start: 1px solid var(--border-glass); padding-block-start: 16px;">
      <span style="font-size: 0.85rem; color: var(--text-secondary); display: block; margin-block-end: 8px;">Card Color:</span>
      <div class="color-picker-row edit-color-picker" style="display: flex; gap: 10px; flex-wrap: wrap;">
        ${swatchesHtml}
      </div>
    </div>
  `;
}

function enterEditMode() {
  isEditingDetail = true;
  const btnEdit = document.getElementById('btn-edit-item');
  if (btnEdit) {
    btnEdit.textContent = 'Save';
    btnEdit.className = 'btn btn--primary btn--small';
  }

  const contentContainer = document.getElementById('detail-modal-content');
  const item = currentDetailItem;

  if (item.type === 'todo') {
    contentContainer.innerHTML = `
      <div class="detail-content">
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">List Title</label>
        <input type="text" id="edit-detail-title" class="edit-input" style="inline-size: 100%; font-size: 1.25rem; font-weight: 700; margin-block-end: 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 10px; border-radius: 8px; box-sizing: border-box;" value="${item.title.replace(/"/g, '&quot;')}" />
        
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Tasks</label>
        <div id="edit-todo-list-container" style="display: flex; flex-direction: column; gap: 8px; margin-block-end: 16px;">
          <!-- Dynamically populated -->
        </div>
        
        <button type="button" id="btn-edit-add-todo" class="btn btn--secondary btn--small" style="display: inline-flex; align-items: center; gap: 6px; margin-block-end: 20px; font-weight: 600;">
          <span style="font-size: 1.1rem; line-height: 1;">+</span> Add item
        </button>

        ${getColorPickerHtml(item.color || 'default')}
      </div>
    `;

    const listContainer = document.getElementById('edit-todo-list-container');

    const renderEditRow = (todo = { text: '', completed: false }) => {
      const row = document.createElement('div');
      row.className = 'edit-todo-row';
      row.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-block-end: 8px;';
      
      row.innerHTML = `
        <input type="checkbox" class="edit-todo-row-checkbox" ${todo.completed ? 'checked' : ''} style="transform: scale(1.15); cursor: pointer;" />
        <input type="text" class="edit-todo-input" style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 8px 12px; border-radius: 8px; box-sizing: border-box; font-size: 0.95rem;" placeholder="List item" value="${todo.text.replace(/"/g, '&quot;')}" />
        <button type="button" class="btn-delete-todo-row" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; font-size: 1.25rem;" title="Delete task">&times;</button>
      `;

      // Handle checkbox change
      const cb = row.querySelector('.edit-todo-row-checkbox');
      const input = row.querySelector('.edit-todo-input');
      cb.addEventListener('change', () => {
        input.style.textDecoration = cb.checked ? 'line-through' : 'none';
        input.style.color = cb.checked ? 'var(--text-muted)' : '#fff';
      });
      // Apply initial styling
      input.style.textDecoration = todo.completed ? 'line-through' : 'none';
      input.style.color = todo.completed ? 'var(--text-muted)' : '#fff';

      // Handle enter key to spawn new item below
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const newRow = renderEditRow();
          row.after(newRow);
          newRow.querySelector('.edit-todo-input').focus();
        }
      });

      // Handle delete button click
      row.querySelector('.btn-delete-todo-row').addEventListener('click', () => {
        row.remove();
        // If list is completely empty, add one empty row
        if (listContainer.children.length === 0) {
          renderEditRow();
        }
      });

      listContainer.appendChild(row);
      return row;
    };

    // Populate existing todos
    const todos = item.content.todos || [];
    if (todos.length > 0) {
      todos.forEach(t => renderEditRow(t));
    } else {
      renderEditRow(); // Always start with at least one empty row
    }

    // Add item click listener
    document.getElementById('btn-edit-add-todo').addEventListener('click', () => {
      const newRow = renderEditRow();
      newRow.querySelector('.edit-todo-input').focus();
    });
  }
  else if (item.type === 'article') {
    contentContainer.innerHTML = `
      <div class="detail-content">
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Article Title</label>
        <input type="text" id="edit-detail-title" class="edit-input" style="inline-size: 100%; font-size: 1.2rem; font-weight: 600; margin-block-end: 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 10px; border-radius: 8px; box-sizing: border-box;" value="${item.title.replace(/"/g, '&quot;')}" />
        
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Article URL</label>
        <input type="text" id="edit-detail-url" class="edit-input" style="inline-size: 100%; font-size: 0.9rem; margin-block-end: 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 10px; border-radius: 8px; box-sizing: border-box;" value="${item.url || ''}" />
        
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Image URL</label>
        <input type="text" id="edit-detail-image" class="edit-input" style="inline-size: 100%; font-size: 0.9rem; margin-block-end: 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 10px; border-radius: 8px; box-sizing: border-box;" value="${item.image || ''}" />

        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Description / Parsed Text</label>
        <textarea id="edit-detail-content" class="edit-textarea" style="inline-size: 100%; block-size: 180px; font-size: 0.95rem; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 12px; border-radius: 8px; resize: vertical; box-sizing: border-box;">${item.content.raw_text || ''}</textarea>
        ${getColorPickerHtml(item.color || 'default')}
      </div>
    `;
  }
  else { // note
    contentContainer.innerHTML = `
      <div class="detail-content">
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Note Title</label>
        <input type="text" id="edit-detail-title" class="edit-input" style="inline-size: 100%; font-size: 1.5rem; font-weight: 700; margin-block-end: 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 10px; border-radius: 8px; box-sizing: border-box;" value="${item.title.replace(/"/g, '&quot;')}" />
        
        <label class="detail-summary-title" style="display: block; margin-block-end: 8px;">Content</label>
        <textarea id="edit-detail-content" class="edit-textarea" style="inline-size: 100%; block-size: 250px; font-family: inherit; font-size: 1rem; line-height: 1.5; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); color: #fff; padding: 12px; border-radius: 8px; resize: vertical; box-sizing: border-box; white-space: pre-wrap;">${item.content.raw_text}</textarea>
        ${getColorPickerHtml(item.color || 'default')}
      </div>
    `;
  }

  // Bind color swatch clicks in edit mode
  document.querySelectorAll('.edit-color-picker .color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('.edit-color-picker .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      
      const panel = document.querySelector('.modal-panel--detail');
      if (panel) {
        panel.className = 'modal-panel modal-panel--detail'; // reset
        panel.classList.add(`color-${swatch.dataset.color}`);
      }
    });
  });
}

async function saveDetailEdits() {
  const item = currentDetailItem;
  if (!item) return;

  let editTitleVal = document.getElementById('edit-detail-title')?.value.trim();
  let editContentVal = document.getElementById('edit-detail-content')?.value.trim();
  let editImageVal = document.getElementById('edit-detail-image')?.value.trim();

  // Read selected color from swatches
  const activeEditSwatch = document.querySelector('.edit-color-picker .color-swatch.active');
  const editColorVal = activeEditSwatch ? activeEditSwatch.dataset.color : 'default';

  // Read checklist items if it's a todo
  let editTodos = [];
  if (item.type === 'todo') {
    const rows = document.querySelectorAll('.edit-todo-row');
    rows.forEach(row => {
      const txt = row.querySelector('.edit-todo-input').value.trim();
      const completed = row.querySelector('.edit-todo-row-checkbox').checked;
      if (txt) {
        editTodos.push({ text: txt, completed });
      }
    });
  }

  const isTodoEmpty = item.type === 'todo' && editTodos.length === 0 && !editTitleVal;
  const isOtherEmpty = item.type !== 'todo' && editTitleVal === undefined && editContentVal === undefined;

  if (isTodoEmpty || isOtherEmpty) {
    showToast('Cannot save empty changes.');
    return;
  }

  let editUrlVal = '';
  let urlChanged = false;
  let cleanedUrl = null;
  let scrapedImage = null;
  let scrapeMeta = null;

  if (item.type === 'article') {
    editUrlVal = document.getElementById('edit-detail-url')?.value.trim() || '';
    cleanedUrl = extractAndCleanUrl(editUrlVal);
    if (cleanedUrl && cleanedUrl !== item.url) {
      urlChanged = true;
    }
  }

  // If URL changed, re-scrape first
  if (urlChanged) {
    try {
      const scrapeRes = await fetch(`/api/scrape?url=${encodeURIComponent(cleanedUrl)}`);
      if (scrapeRes.ok) {
        scrapeMeta = await scrapeRes.json();
        scrapedImage = scrapeMeta.image;
        
        // If user didn't modify title/description, use the scraped ones
        if (editTitleVal === item.title && scrapeMeta.title) {
          editTitleVal = scrapeMeta.title;
        }
        if (editContentVal === item.content.raw_text && scrapeMeta.description) {
          editContentVal = scrapeMeta.description;
        }
      }
    } catch (e) {
      console.error('Failed to re-scrape URL on edit:', e);
    }
  }

  // Setup input for AI
  let aiInputText = editContentVal || '';
  if (item.type === 'article') {
    aiInputText = `Webpage URL: ${cleanedUrl || editUrlVal || item.url}\nTitle: ${editTitleVal}\nDescription: ${editContentVal}`;
  } else if (item.type === 'note') {
    aiInputText = `Title: ${editTitleVal}\nContent: ${editContentVal}`;
  } else if (item.type === 'todo') {
    aiInputText = `Title: ${editTitleVal}\nTasks: ${editTodos.map(t => t.text).join(', ')}`;
  }

  let aiParsed = null;
  if (item.type !== 'todo' && item.type !== 'note') {
    showToast('AI is analyzing updated changes...');
    setSyncStatus('syncing', 'AI Analyzing...');
    try {
      aiParsed = await analyzeInputWithAI(aiInputText);
    } catch (aiErr) {
      console.error('AI analysis during edit failed:', aiErr);
      showToast('AI analysis failed. Using basic save.');
    }
  }

  // Update item object properties
  if (editColorVal !== undefined) {
    item.color = editColorVal;
  }
  if (editTitleVal !== undefined) {
    item.title = editTitleVal;
  }
  if (editContentVal !== undefined && item.type !== 'todo') {
    item.content.raw_text = editContentVal;
    item.content.word_count = editContentVal.split(/\s+/).length;
    item.content.reading_time_mins = Math.max(1, Math.ceil(item.content.word_count / 200));
  }

  // If AI completed successfully, update AI analysis fields
  if (aiParsed) {
    item.ai_analysis = aiParsed.ai_analysis || item.ai_analysis;
    // Update title only if user did not provide one and AI returned one
    if (!editTitleVal && aiParsed.title) {
      item.title = aiParsed.title;
    }
  }

  // Special properties per type
  if (item.type === 'todo') {
    item.content.todos = editTodos;
    item.content.raw_text = editTodos.map(t => t.text).join(', ');
    item.content.word_count = editTodos.map(t => t.text).join(' ').split(/\s+/).length;
    item.content.reading_time_mins = 1;

    // Make sure we have a clean summary and todo tag
    item.ai_analysis = item.ai_analysis || {};
    item.ai_analysis.summary = 'To-Do Checklist';
    item.ai_analysis.tags = item.ai_analysis.tags || [];
    if (!item.ai_analysis.tags.includes('todo')) {
      item.ai_analysis.tags.push('todo');
    }
  }
  else if (item.type === 'article') {
    if (cleanedUrl) {
      item.url = cleanedUrl;
    } else if (editUrlVal !== undefined) {
      item.url = editUrlVal;
    }
    if (editImageVal !== undefined) {
      item.image = editImageVal;
    } else if (urlChanged && scrapedImage !== null) {
      item.image = scrapedImage;
    }
  }

  showToast('Saving changes to Google Drive...');
  setSyncStatus('syncing', 'Saving edits...');

  try {
    // 1. Upload updated content to Google Drive
    await uploadFileContent(item._drive_file_id, item);

    // 2. Update local files cache
    const idx = driveFiles.findIndex(el => el.id === item.id);
    if (idx !== -1) {
      driveFiles[idx] = item;
    }
    
    // Clear old chunks to trigger re-indexing
    delete item.rag_chunks;
    saveFilesCache();
    
    MindDB.deleteChunks(item.id).then(() => {
      runBackgroundEmbeddingIndexing();
    }).catch(e => console.error('Failed to delete old chunks on edit:', e));

    setSyncStatus('synced', 'Synced');
    showToast('Changes saved!');
    
    // 3. Reset edit state and re-show the modal in view mode
    isEditingDetail = false;
    showDetailModal(item);
    renderGrid();
  } catch (err) {
    console.error('Failed to save edit details:', err);
    showToast('Failed to save changes to Google Drive.');
    setSyncStatus('synced', 'Sync Failed');
  }
}

// --- Configuration Management ---
function sanitizeValue(val, fallback) {
  if (val === undefined || val === null) return fallback;
  const str = String(val).trim();
  if (str === '' || str === 'undefined' || str === 'null') return fallback;
  return str;
}

function applyCardOpacity(opacity) {
  const root = document.documentElement;
  const activeOpacity = sanitizeValue(opacity, '0.50');
  root.style.setProperty('--card-opacity', activeOpacity);
}

function initSettingsForm() {
  const geminiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  const opacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');

  const geminiInput = document.getElementById('setting-gemini-key');
  const opacityInput = document.getElementById('setting-card-opacity');
  const opacityVal = document.getElementById('setting-opacity-val');

  if (geminiInput) geminiInput.value = geminiKey;

  const parsedOpacity = parseFloat(opacity);
  const opacityPercent = isNaN(parsedOpacity) ? 50 : Math.round(parsedOpacity * 100);
  if (opacityInput) opacityInput.value = opacityPercent;
  if (opacityVal) opacityVal.textContent = opacityPercent + '%';
}

function revertLiveSettings() {
  const savedOpacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');
  applyCardOpacity(savedOpacity);
}

async function saveSettings(e) {
  e.preventDefault();
  const geminiKey = document.getElementById('setting-gemini-key').value.trim();
  const opacity = (document.getElementById('setting-card-opacity').value / 100).toFixed(2);

  safeStorage.setItem(STORAGE_KEYS.GEMINI_KEY, geminiKey);
  safeStorage.setItem('mymind_card_opacity', opacity);

  applyCardOpacity(opacity);

  closeModal('settings-modal');
  showToast('Saving settings...');

  try {
    await syncSettingsToDrive(geminiKey, opacity);
    showToast('Settings saved & synced.');
    runBackgroundEmbeddingIndexing();
  } catch (err) {
    showToast('Settings saved locally. Sync failed.');
  }
}

function checkOnboarding() {
  const geminiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';

  if (!geminiKey) {
    openModal('onboarding-modal');
  }
}

async function saveOnboardingSettings() {
  const geminiKeyInput = document.getElementById('onboarding-gemini-key');
  const geminiKey = geminiKeyInput ? geminiKeyInput.value.trim() : '';

  if (!geminiKey) {
    showToast('Please enter a Gemini API Key or click "Skip for Now".');
    return;
  }

  safeStorage.setItem(STORAGE_KEYS.GEMINI_KEY, geminiKey);

  // Sync to settings-modal input just in case
  const geminiInput = document.getElementById('setting-gemini-key');
  if (geminiInput) geminiInput.value = geminiKey;

  closeModal('onboarding-modal');
  showToast('AI Setup complete! Saving settings...');

  try {
    const opacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');
    await syncSettingsToDrive(geminiKey, opacity);
    showToast('Settings saved & synced.');
    runBackgroundEmbeddingIndexing();
  } catch (err) {
    showToast('Settings saved locally. Sync failed.');
  }
}

function skipOnboarding() {
  closeModal('onboarding-modal');
  showToast('Onboarding skipped. You can configure AI later in Settings (⚙️).');
}

// Simple encryption using XOR with a key derived from user ID
function encryptKey(text, key) {
  if (!text) return '';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(unescape(encodeURIComponent(result))); // Base64 encode
}

function decryptKey(encoded, key) {
  if (!encoded) return '';
  try {
    const text = decodeURIComponent(escape(atob(encoded)));
    let result = '';
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  } catch (e) {
    console.error('Decryption failed:', e);
    return '';
  }
}

async function loadSettingsFromDrive() {
  if (!accessToken) return;
  setSyncStatus('syncing', 'Loading Settings...');
  try {
    // Search settings.json in appDataFolder
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='settings.json' and mimeType='application/json'&fields=files(id, name)`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      throw new Error(`Failed to list settings from Google Drive: ${res.status}`);
    }
    const data = await res.json();
    
    if (data.files && data.files.length > 0) {
      const file = data.files[0];
      settingsFileId = file.id;
      safeStorage.setItem('settings_file_id', file.id);

      const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!contentRes.ok) {
        throw new Error(`Failed to get settings content: ${contentRes.status}`);
      }
      const remoteSettings = await contentRes.json();
      
      // Decrypt Gemini API key
      const encryptionKey = googleUserId || safeStorage.getItem('mymind_google_user_id') || 'mymindspace_fallback';
      if (remoteSettings.encryptedGeminiKey) {
        const decryptedKey = decryptKey(remoteSettings.encryptedGeminiKey, encryptionKey);
        if (decryptedKey) {
          safeStorage.setItem(STORAGE_KEYS.GEMINI_KEY, decryptedKey);
          const geminiInput = document.getElementById('setting-gemini-key');
          if (geminiInput) geminiInput.value = decryptedKey;
        }
      }

      if (remoteSettings.cardOpacity) {
        safeStorage.setItem('mymind_card_opacity', sanitizeValue(remoteSettings.cardOpacity, '0.50'));
      }

      applyCardOpacity(
        sanitizeValue(remoteSettings.cardOpacity, '0.50')
      );
      
      setSyncStatus('synced', 'Synced');
    } else {
      console.log('settings.json not found on Google Drive.');
    }
  } catch (err) {
    console.error('Failed to load settings from Google Drive:', err);
    throw err;
  }
}

async function syncSettingsToDrive(geminiKey, opacity) {
  if (!accessToken) return;
  setSyncStatus('syncing', 'Syncing Settings...');
  try {
    const encryptionKey = googleUserId || safeStorage.getItem('mymind_google_user_id') || 'mymindspace_fallback';
    const encryptedGeminiKey = encryptKey(geminiKey, encryptionKey);

    const activeOpacity = sanitizeValue(opacity || safeStorage.getItem('mymind_card_opacity'), '0.50');

    const settingsPayload = {
      encryptedGeminiKey,
      cardOpacity: activeOpacity,
      updated_at: new Date().toISOString()
    };

    let fileId = settingsFileId || safeStorage.getItem('settings_file_id');
    
    if (!fileId) {
      // Search again
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='settings.json' and mimeType='application/json'&fields=files(id)`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!res.ok) {
        throw new Error(`Failed to check settings file on Google Drive: ${res.status}`);
      }
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        fileId = data.files[0].id;
        settingsFileId = fileId;
        safeStorage.setItem('settings_file_id', fileId);
      }
    }

    if (fileId) {
      await uploadFileContent(fileId, settingsPayload);
      setSyncStatus('synced', 'Synced');
    } else {
      // Create new settings.json file
      console.log('Creating settings.json on Google Drive...');
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'settings.json',
          mimeType: 'application/json',
          parents: ['appDataFolder']
        })
      });
      if (!createRes.ok) {
        throw new Error(`Failed to create settings file on Google Drive: ${createRes.status}`);
      }
      const newFile = await createRes.json();
      fileId = newFile.id;
      settingsFileId = fileId;
      safeStorage.setItem('settings_file_id', fileId);
      
      await uploadFileContent(fileId, settingsPayload);
      setSyncStatus('synced', 'Synced');
    }
  } catch (err) {
    console.error('Failed to sync settings to Google Drive:', err);
    setSyncStatus('synced', 'Sync Failed');
    throw err;
  }
}

function logout() {
  safeStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  accessToken = null;
  driveFiles = [];
  folders = [];
  
  // Call server to clear HTTP-Only cookie
  fetch('/api/logout', { method: 'POST', credentials: 'include' })
    .catch(err => console.warn('Failed to clear cookie on logout:', err));

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
  ensureValidToken(() => {
    verifyAndFetchData().catch(err => {
      console.error('Failed to refresh data:', err);
      showToast('Failed to sync. Please try again.');
    });
  });
}

// --- Automatic Sync Engine (Real-time Focus & Periodic Polling) ---
const SYNC_COOLDOWN_MS = 10000; // Throttle sync requests to at most once every 10 seconds

function triggerBackgroundSync() {
  if (!accessToken) return;
  
  // Skip sync if an item is currently being saved to avoid race conditions
  if (driveFiles.some(item => item.isPlaceholder)) {
    console.log('Background sync skipped: an item is currently being saved/processed.');
    return;
  }
  
  const now = Date.now();
  if (now - lastSyncTime < SYNC_COOLDOWN_MS) {
    console.log('Sync request throttled.');
    return;
  }
  
  lastSyncTime = now;
  console.log('Running automatic background sync...');
  
  ensureValidToken(() => {
    setSyncStatus('syncing', 'Checking for updates...');
    
    // Fetch folders and mind items in parallel
    loadFolders().then(() => {
      Promise.all([
        loadSettingsFromDrive(),
        loadMindItems()
      ]).then(() => {
        console.log('Background sync completed.');
        setSyncStatus('synced', 'Synced');
      }).catch(err => {
        console.error('Background sync failed:', err);
        setSyncStatus('synced', 'Sync Failed');
      });
    }).catch(err => {
      console.error('Background sync folder load failed:', err);
      setSyncStatus('synced', 'Sync Failed');
    });
  });
}

function startAutoSyncLoop() {
  if (syncIntervalId) clearInterval(syncIntervalId);
  
  // 1. Periodic poll: every 60 seconds if the page is visible and active
  syncIntervalId = setInterval(() => {
    if (document.visibilityState === 'visible' && accessToken) {
      triggerBackgroundSync();
    }
  }, 60000);
  
  // 2. Real-time Focus: instant sync when user returns to the tab/app
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && accessToken) {
      triggerBackgroundSync();
    }
  });
  
  // 3. Focus listener for desktop window switching
  window.addEventListener('focus', () => {
    if (accessToken) {
      triggerBackgroundSync();
    }
  });
}

function ensureValidToken(callback, forceLandingPageOnExpiry = false) {
  const expiresAt = parseInt(safeStorage.getItem('mymind_token_expires_at') || '0', 10);
  
  if (accessToken && Date.now() + 300000 <= expiresAt) {
    callback();
    return;
  }
  
  console.log('Google Access Token is expired or expiring soon. Attempting silent refresh...');
  
  refreshAccessTokenFromServer()
    .then(() => {
      console.log('Silent token refresh successful.');
      callback();
    })
    .catch((err) => {
      console.warn('Silent token refresh failed:', err);
      
      if (forceLandingPageOnExpiry) {
        console.log('Token expired on startup and silent refresh failed. Redirecting to landing page.');
        logout();
      } else {
        console.log('Token expired in-app and silent refresh failed. Showing Session Expired banner.');
        onAuthSuccessCallback = callback;
        showSessionExpiredBanner();
      }
    });
}

function showSessionExpiredBanner() {
  const banner = document.getElementById('session-expired-banner');
  if (banner) {
    banner.style.display = 'flex';
  }
}

function hideSessionExpiredBanner() {
  const banner = document.getElementById('session-expired-banner');
  if (banner) {
    banner.style.display = 'none';
  }
}

// ==========================================================================
// Spatial Canvas (Mind Map) Rendering Engine & Event System
// ==========================================================================

function resetCanvasView() {
  const view = document.getElementById('spatial-canvas-view');
  if (!view) return;
  canvasPanX = Math.round(view.clientWidth / 2);
  canvasPanY = Math.round(view.clientHeight / 2);
  canvasZoom = 1;
  updateCanvasTransform();
}

function zoomAtCenter(factor) {
  const viewport = document.getElementById('spatial-canvas-viewport');
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  
  const canvasX = (centerX - canvasPanX) / canvasZoom;
  const canvasY = (centerY - canvasPanY) / canvasZoom;
  
  canvasZoom = Math.min(Math.max(canvasZoom * factor, 0.15), 3.0);
  canvasPanX = centerX - canvasX * canvasZoom;
  canvasPanY = centerY - canvasY * canvasZoom;
  
  updateCanvasTransform();
}

function zoomToFit() {
  if (lastRenderedSpatialItems.length === 0) {
    resetCanvasView();
    return;
  }
  
  const viewport = document.getElementById('spatial-canvas-viewport');
  if (!viewport) return;
  
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  
  lastRenderedSpatialItems.forEach(item => {
    const cardEl = document.querySelector(`.canvas-node-card[data-id="${item.id}"]`);
    const w = cardEl ? cardEl.offsetWidth : 280;
    const h = cardEl ? cardEl.offsetHeight : 180;
    
    const x = item.canvas_x || 0;
    const y = item.canvas_y || 0;
    
    if (x < minX) minX = x;
    if (x + w > maxX) maxX = x + w;
    if (y < minY) minY = y;
    if (y + h > maxY) maxY = y + h;
  });
  
  const padding = 60;
  const boundsW = maxX - minX;
  const boundsH = maxY - minY;
  
  const viewW = viewport.clientWidth;
  const viewH = viewport.clientHeight;
  
  const scaleX = (viewW - padding * 2) / boundsW;
  const scaleY = (viewH - padding * 2) / boundsH;
  let newZoom = Math.min(scaleX, scaleY);
  
  newZoom = Math.min(Math.max(newZoom, 0.15), 1.5);
  
  const boundsCenterX = minX + boundsW / 2;
  const boundsCenterY = minY + boundsH / 2;
  
  canvasZoom = newZoom;
  canvasPanX = viewW / 2 - boundsCenterX * canvasZoom;
  canvasPanY = viewH / 2 - boundsCenterY * canvasZoom;
  
  updateCanvasTransform();
}

function toggleLinkMode() {
  isLinking = !isLinking;
  const btn = document.getElementById('btn-canvas-link-mode');
  const view = document.getElementById('spatial-canvas-view');
  
  if (isLinking) {
    btn.classList.add('active');
    view.classList.add('linking-active');
    showToast('Connection Mode active. Click two cards to link/unlink them.');
  } else {
    btn.classList.remove('active');
    view.classList.remove('linking-active');
    if (linkSourceId) {
      const card = document.querySelector(`.canvas-node-card[data-id="${linkSourceId}"]`);
      if (card) card.classList.remove('linking-source');
      linkSourceId = null;
    }
  }
}

function updateCanvasTransform() {
  const canvas = document.getElementById('spatial-canvas');
  if (canvas) {
    canvas.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
  }
  updateMinimap(lastRenderedSpatialItems);
}

function debounceSaveItem(item) {
  if (nodeSaveDebounceTimers[item.id]) {
    clearTimeout(nodeSaveDebounceTimers[item.id]);
  }
  
  nodeSaveDebounceTimers[item.id] = setTimeout(async () => {
    delete nodeSaveDebounceTimers[item.id];
    setSyncStatus('syncing', 'Syncing position...');
    try {
      await uploadFileContent(item._drive_file_id, item);
      saveFilesCache();
      setSyncStatus('synced', 'Synced');
    } catch (err) {
      console.error('Failed to update node coordinates on Google Drive:', err);
      setSyncStatus('synced', 'Sync Failed');
    }
  }, 1200);
}

function drawConnections(items) {
  const svg = document.getElementById('canvas-svg');
  if (!svg) return;
  
  svg.innerHTML = '';
  const renderedLineKeys = new Set();
  
  // Sync rendered node sizes on screen to reflect their degrees in Graph Mode
  if (canvasViewMode === 'graph') {
    items.forEach(item => {
      const cardEl = document.querySelector(`.canvas-node-card[data-id="${item.id}"]`);
      if (cardEl) {
        const size = getNodeSize(item, items).w;
        cardEl.style.setProperty('--node-size', `${size}px`);
      }
    });
  }
  
  // Helper to create non-scaling thick click overlays
  function createInteractionPath(pathData, sourceId, targetId, clickHandler, dblclickHandler = null) {
    const iPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iPath.setAttribute('d', pathData);
    iPath.setAttribute('fill', 'none');
    iPath.setAttribute('stroke', 'transparent');
    iPath.setAttribute('stroke-width', '16px'); // Nice fat target!
    iPath.setAttribute('vector-effect', 'non-scaling-stroke'); // Click target size constant
    iPath.setAttribute('pointer-events', 'stroke');
    iPath.style.cursor = 'pointer';
    iPath.dataset.sourceId = sourceId;
    iPath.dataset.targetId = targetId;

    if (clickHandler) {
      iPath.addEventListener('click', (e) => {
        e.stopPropagation();
        clickHandler(e);
      });
    }
    if (dblclickHandler) {
      iPath.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        dblclickHandler(e);
      });
    }
    return iPath;
  }

  // 1. Draw Manual User-created Connections (Glowing solid purple curves/lines)
  items.forEach(A => {
    if (!A.connections || A.connections.length === 0) return;
    
    const sizeA = getNodeSize(A, items);
    const x1 = (A.canvas_x || 0) + sizeA.w / 2;
    const y1 = (A.canvas_y || 0) + sizeA.h / 2;
    
    A.connections.forEach(targetId => {
      const lineKey = A.id < targetId ? `${A.id}-${targetId}` : `${targetId}-${A.id}`;
      if (renderedLineKeys.has(lineKey)) return;
      
      const B = items.find(x => x.id === targetId);
      if (!B) return;
      
      const sizeB = getNodeSize(B, items);
      const x2 = (B.canvas_x || 0) + sizeB.w / 2;
      const y2 = (B.canvas_y || 0) + sizeB.h / 2;
      
      const dx = x2 - x1;
      const dy = y2 - y1;
      const cx1 = x1 + dx * 0.4;
      const cy1 = y1;
      const cx2 = x2 - dx * 0.4;
      const cy2 = y2;
      
      const pathData = canvasViewMode === 'graph'
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
      
      // Visual path
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('class', canvasViewMode === 'graph' ? 'canvas-connection-line--graph' : 'canvas-connection-line');
      path.setAttribute('vector-effect', 'non-scaling-stroke'); // Visual stroke size constant
      path.setAttribute('pointer-events', 'none'); // Let interaction overlay handle mouse events
      path.dataset.sourceId = A.id;
      path.dataset.targetId = B.id;
      
      const onDblclick = async (e) => {
        const confirmed = await showConfirm(
          'Delete Connection',
          'Are you sure you want to disconnect these notes?',
          'Disconnect',
          'Cancel'
        );
        if (confirmed) {
          A.connections = A.connections.filter(id => id !== targetId);
          debounceSaveItem(A);
          
          if (B.connections) {
            B.connections = B.connections.filter(id => id !== A.id);
            debounceSaveItem(B);
          }
          
          drawConnections(items);
        }
      };

      // Create transparent interaction overlay
      const iPath = createInteractionPath(pathData, A.id, B.id, null, onDblclick);
      
      svg.appendChild(path);
      svg.appendChild(iPath);
      renderedLineKeys.add(lineKey);
    });
  });

  // 2. Draw Autoformed Semantic Connections (Soft dotted curves/lines)
  const ignoredTags = new Set(['inbox', 'link', 'web', 'to-read', 'todo', 'note', 'article', 'color', 'saved note']);
  
  for (let i = 0; i < items.length; i++) {
    const A = items[i];
    if (!A.ai_analysis || !A.ai_analysis.tags) continue;
    const tagsA = A.ai_analysis.tags.map(t => t.toLowerCase()).filter(t => !ignoredTags.has(t));
    if (tagsA.length === 0) continue;
    
    for (let j = i + 1; j < items.length; j++) {
      const B = items[j];
      if (!B.ai_analysis || !B.ai_analysis.tags) continue;
      const tagsB = B.ai_analysis.tags.map(t => t.toLowerCase());
      
      const overlapTags = tagsA.filter(tag => tagsB.includes(tag));
      if (overlapTags.length === 0) continue;
      
      const lineKey = A.id < B.id ? `${A.id}-${B.id}` : `${B.id}-${A.id}`;
      if (renderedLineKeys.has(lineKey)) continue;
      
      const sizeA = getNodeSize(A, items);
      const x1 = (A.canvas_x || 0) + sizeA.w / 2;
      const y1 = (A.canvas_y || 0) + sizeA.h / 2;
      
      const sizeB = getNodeSize(B, items);
      const x2 = (B.canvas_x || 0) + sizeB.w / 2;
      const y2 = (B.canvas_y || 0) + sizeB.h / 2;
      
      const dx = x2 - x1;
      const dy = y2 - y1;
      const cx1 = x1 + dx * 0.4;
      const cy1 = y1;
      const cx2 = x2 - dx * 0.4;
      const cy2 = y2;
      
      const pathData = canvasViewMode === 'graph'
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
      
      // Visual path
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('class', canvasViewMode === 'graph' ? 'canvas-connection-line--graph-auto' : 'canvas-connection-line--auto');
      path.setAttribute('vector-effect', 'non-scaling-stroke'); // Visual stroke size constant
      path.setAttribute('pointer-events', 'none');
      path.dataset.sourceId = A.id;
      path.dataset.targetId = B.id;
      
      // Single click enquiry handler
      const onClick = () => {
        const tagBadges = overlapTags.map(tag => 
          `<span style="background: rgba(6, 182, 212, 0.15); color: #22d3ee; padding: 4px 10px; border-radius: 12px; font-size: 0.85rem; font-weight: 600; border: 1px solid rgba(6, 182, 212, 0.3); margin-inline-end: 6px; display: inline-block;">#${tag}</span>`
        ).join(' ');

        showConfirm(
          'Auto-Connection Details',
          `This connection between <strong>"${A.title}"</strong> and <strong>"${B.title}"</strong> was automatically formed because they share the following tag(s):<br><br>` + 
          tagBadges + 
          `<br><br><span style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">To separate them, edit the tags on either card to remove the overlap.</span>`,
          'OK',
          null // Hide cancel button
        );
      };

      // Create transparent interaction overlay
      const iPath = createInteractionPath(pathData, A.id, B.id, onClick, null);
      
      svg.appendChild(path);
      svg.appendChild(iPath);
      renderedLineKeys.add(lineKey);
    }
  }
}

function updateMinimap(items) {
  const minimap = document.getElementById('canvas-minimap');
  const viewportBox = document.getElementById('canvas-minimap-viewport');
  const dotsContainer = document.getElementById('canvas-minimap-dots');
  
  if (!minimap || !viewportBox || !dotsContainer) return;
  
  if (items.length === 0) {
    minimap.style.display = 'none';
    return;
  }
  minimap.style.display = 'block';
  dotsContainer.innerHTML = '';
  
  const viewport = document.getElementById('spatial-canvas-viewport');
  if (!viewport) return;
  
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  
  items.forEach(item => {
    const x = item.canvas_x || 0;
    const y = item.canvas_y || 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  
  minX -= 300;
  maxX += 580;
  minY -= 300;
  maxY += 450;
  
  const boundsW = maxX - minX;
  const boundsH = maxY - minY;
  
  const mapW = 160;
  const mapH = 120;
  
  const scaleX = mapW / boundsW;
  const scaleY = mapH / boundsH;
  const mapScale = Math.min(scaleX, scaleY);
  
  const offsetX = (mapW - boundsW * mapScale) / 2;
  const offsetY = (mapH - boundsH * mapScale) / 2;
  
  items.forEach(item => {
    const x = item.canvas_x || 0;
    const y = item.canvas_y || 0;
    
    const dot = document.createElement('div');
    dot.className = `minimap-dot color-${item.color || 'default'}`;
    dot.style.left = `${(x - minX) * mapScale + offsetX}px`;
    dot.style.top = `${(y - minY) * mapScale + offsetY}px`;
    dotsContainer.appendChild(dot);
  });
  
  const viewW = viewport.clientWidth;
  const viewH = viewport.clientHeight;
  
  const viewLeft = -canvasPanX / canvasZoom;
  const viewTop = -canvasPanY / canvasZoom;
  const viewRight = (viewW - canvasPanX) / canvasZoom;
  const viewBottom = (viewH - canvasPanY) / canvasZoom;
  
  const viewMapLeft = Math.max(0, (viewLeft - minX) * mapScale + offsetX);
  const viewMapTop = Math.max(0, (viewTop - minY) * mapScale + offsetY);
  const viewMapRight = Math.min(mapW, (viewRight - minX) * mapScale + offsetX);
  const viewMapBottom = Math.min(mapH, (viewBottom - minY) * mapScale + offsetY);
  
  viewportBox.style.left = `${viewMapLeft}px`;
  viewportBox.style.top = `${viewMapTop}px`;
  viewportBox.style.width = `${Math.max(4, viewMapRight - viewMapLeft)}px`;
  viewportBox.style.height = `${Math.max(4, viewMapBottom - viewMapTop)}px`;
}

function getCanvasCenterCoords() {
  const viewport = document.getElementById('spatial-canvas-viewport');
  if (!viewport) return { x: 0, y: 0 };
  const rect = viewport.getBoundingClientRect();
  const mouseX = rect.width / 2;
  const mouseY = rect.height / 2;
  const canvasX = Math.round((mouseX - canvasPanX) / canvasZoom);
  const canvasY = Math.round((mouseY - canvasPanY) / canvasZoom);
  return { x: canvasX, y: canvasY };
}

function getNodeSize(item, items) {
  if (canvasViewMode !== 'graph') {
    const cardEl = document.querySelector(`.canvas-node-card[data-id="${item.id}"]`);
    const w = 280;
    const h = cardEl && cardEl.offsetHeight > 0 ? cardEl.offsetHeight : 200;
    return { w, h };
  }
  let degree = (item.connections || []).length;
  if (item.ai_analysis && item.ai_analysis.tags) {
    const ignoredTags = new Set(['inbox', 'link', 'web', 'to-read', 'todo', 'note', 'article', 'color', 'saved note']);
    const tagsA = item.ai_analysis.tags.map(t => t.toLowerCase()).filter(t => !ignoredTags.has(t));
    if (tagsA.length > 0) {
      items.forEach(other => {
        if (other.id === item.id) return;
        if (!other.ai_analysis || !other.ai_analysis.tags) return;
        const tagsB = other.ai_analysis.tags.map(t => t.toLowerCase());
        const hasOverlap = tagsA.some(tag => tagsB.includes(tag));
        if (hasOverlap) {
          degree++;
        }
      });
    }
  }
  const size = Math.max(14, Math.min(36, 14 + degree * 2));
  return { w: size, h: size };
}

function renderSpatialCanvas(items) {
  lastRenderedSpatialItems = items;
  
  let unplacedCount = 0;
  items.forEach((item) => {
    if (item.canvas_x === undefined || item.canvas_y === undefined) {
      const cols = 4;
      const col = unplacedCount % cols;
      const row = Math.floor(unplacedCount / cols);
      item.canvas_x = col * 310 - 465;
      item.canvas_y = row * 210 - 210;
      unplacedCount++;
      debounceSaveItem(item);
    }
  });

  const container = document.getElementById('canvas-nodes-container');
  if (!container) return;
  container.innerHTML = '';
  
  items.forEach(item => {
    const card = document.createElement('div');
    card.dataset.id = item.id;
    card.className = `mind-card mind-card--${item.type} color-${item.color || 'default'} canvas-node-card`;
    
    if (canvasViewMode === 'graph') {
      card.classList.add('graph-mode');
      const size = getNodeSize(item, items).w;
      card.style.setProperty('--node-size', `${size}px`);
    }
    
    card.style.left = `${item.canvas_x}px`;
    card.style.top = `${item.canvas_y}px`;
    
    if (item.type === 'todo') {
      const todos = item.content.todos || [];
      const visibleTodos = todos.slice(0, 5);
      const remainingCount = todos.length - visibleTodos.length;
      
      const todoListHtml = visibleTodos.map((todo, idx) => `
        <label class="card-todo-item" style="display: flex; align-items: flex-start; gap: 8px; font-size: 0.9rem; margin-block-end: 6px; cursor: pointer; pointer-events: auto;">
          <input type="checkbox" class="card-todo-checkbox" data-item-id="${item.id}" data-todo-index="${idx}" ${todo.completed ? 'checked' : ''} style="margin-block-start: 3px;" />
          <span class="card-todo-text" style="text-decoration: ${todo.completed ? 'line-through' : 'none'}; color: ${todo.completed ? 'var(--text-muted)' : 'var(--text-primary)'};">${todo.text}</span>
        </label>
      `).join('');

      card.innerHTML = `
        <div class="card-note-title" style="margin-block-end: 12px; padding-inline-end: 28px;">${item.title}</div>
        <div class="card-todo-list" style="margin-block-end: 12px; pointer-events: auto;">
          ${todoListHtml || '<div style="color: var(--text-muted); font-style: italic;">Empty list</div>'}
          ${remainingCount > 0 ? `<div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic; margin-inline-start: 22px; margin-block-start: 4px;">+ ${remainingCount} more tasks</div>` : ''}
        </div>
        <div class="card-meta">
          <span class="card-date" style="margin-inline-start: auto;">${formatCardDate(item.created_at)}</span>
        </div>
      `;
    }
    else if (item.type === 'article') {
      const thumbImg = item.image ? `<img class="card-article-thumb" src="${item.image}" alt="${item.title}" onerror="this.style.display='none';" />` : '';
      card.innerHTML = `
        ${thumbImg}
        <div class="card-article-content">
          <div class="card-article-source" style="padding-inline-end: 28px;">${item.title}</div>
          <div class="card-article-title">${item.ai_analysis.detailed_summary || item.ai_analysis.summary}</div>
          <div class="card-meta">
            <span class="card-date" style="margin-inline-start: auto;">${formatCardDate(item.created_at)}</span>
          </div>
        </div>
      `;
    } 
    else { // note
      card.innerHTML = `
        <div class="card-note-title" style="padding-inline-end: 28px;">${item.title}</div>
        <div class="card-note-desc">${item.ai_analysis.detailed_summary || item.ai_analysis.summary}</div>
        <div class="card-meta">
          <span class="card-date" style="margin-inline-start: auto;">${formatCardDate(item.created_at)}</span>
        </div>
      `;
    }

    const pinBtn = document.createElement('button');
    pinBtn.className = `card-pin-btn ${item.pinned ? 'is-pinned' : ''}`;
    pinBtn.title = item.pinned ? 'Unpin note' : 'Pin note';
    pinBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="${item.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="17" x2="12" y2="22"></line>
        <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.26V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.26a2 2 0 0 1-.78 1.24l-2.78 3.5a2 2 0 0 0-.44 1.24z"></path>
      </svg>
    `;
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(item);
    });
    card.appendChild(pinBtn);

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('card-todo-checkbox') || e.target.closest('.card-pin-btn') || isLinking) {
        return;
      }
      if (canvasNodeDragged) {
        canvasNodeDragged = false;
        return;
      }
      showDetailModal(item);
    });

    card.querySelectorAll('.card-todo-checkbox').forEach(cb => {
      cb.addEventListener('change', async (e) => {
        const idx = parseInt(e.target.dataset.todoIndex, 10);
        if (!item.content.todos) item.content.todos = [];
        item.content.todos[idx].completed = cb.checked;
        
        const textEl = cb.nextElementSibling;
        if (textEl) {
          textEl.style.textDecoration = cb.checked ? 'line-through' : 'none';
          textEl.style.color = cb.checked ? 'var(--text-muted)' : 'var(--text-primary)';
        }

        setSyncStatus('syncing', 'Updating task...');
        try {
          await uploadFileContent(item._drive_file_id, item);
          saveFilesCache();
          setSyncStatus('synced', 'Synced');
        } catch (err) {
          console.error('Failed to update task state on Drive:', err);
          showToast('Sync failed.');
          setSyncStatus('synced', 'Sync Failed');
        }
      });
    });
    
    if (isLinking && linkSourceId === item.id) {
      card.classList.add('linking-source');
    }

    if (canvasViewMode === 'graph') {
      const label = document.createElement('div');
      label.className = 'graph-node-label';
      label.textContent = item.title;
      card.appendChild(label);
    }

    container.appendChild(card);
  });

  if (canvasPanX === 0 && canvasPanY === 0) {
    resetCanvasView();
  }

  drawConnections(items);
  updateMinimap(items);
}

function initSpatialCanvasEvents() {
  const viewport = document.getElementById('spatial-canvas-viewport');
  const btnZoomIn = document.getElementById('btn-canvas-zoom-in');
  const btnZoomOut = document.getElementById('btn-canvas-zoom-out');
  const btnZoomFit = document.getElementById('btn-canvas-zoom-fit');
  const btnLinkMode = document.getElementById('btn-canvas-link-mode');
  
  if (!viewport) return;
  
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const canvasX = (mouseX - canvasPanX) / canvasZoom;
    const canvasY = (mouseY - canvasPanY) / canvasZoom;
    
    const zoomFactor = 1.12;
    let newZoom = canvasZoom;
    if (e.deltaY < 0) {
      newZoom = Math.min(newZoom * zoomFactor, 3.0);
    } else {
      newZoom = Math.max(newZoom / zoomFactor, 0.15);
    }
    
    canvasPanX = mouseX - canvasX * newZoom;
    canvasPanY = mouseY - canvasY * newZoom;
    canvasZoom = newZoom;
    
    updateCanvasTransform();
  }, { passive: false });
  
  viewport.addEventListener('pointerdown', (e) => {
    const cardEl = e.target.closest('.canvas-node-card');
    
    if (cardEl) {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('a')) {
        return;
      }
      
      const cardId = cardEl.dataset.id;
      const item = driveFiles.find(x => x.id === cardId);
      if (!item) return;
      
      if (isLinking) {
        e.stopPropagation();
        if (linkSourceId === null) {
          linkSourceId = item.id;
          cardEl.classList.add('linking-source');
          showToast('Source card selected. Now click the target card to connect.');
        } else if (linkSourceId === item.id) {
          cardEl.classList.remove('linking-source');
          linkSourceId = null;
          showToast('Selection cleared.');
        } else {
          const sourceItem = driveFiles.find(x => x.id === linkSourceId);
          if (sourceItem) {
            sourceItem.connections = sourceItem.connections || [];
            item.connections = item.connections || [];
            
            if (sourceItem.connections.includes(item.id)) {
              sourceItem.connections = sourceItem.connections.filter(id => id !== item.id);
              item.connections = item.connections.filter(id => id !== sourceItem.id);
              showToast('Notes disconnected.');
            } else {
              sourceItem.connections.push(item.id);
              item.connections.push(sourceItem.id);
              showToast('Notes connected!');
            }
            
            debounceSaveItem(sourceItem);
            debounceSaveItem(item);
            
            const prevSourceEl = document.querySelector(`.canvas-node-card[data-id="${linkSourceId}"]`);
            if (prevSourceEl) prevSourceEl.classList.remove('linking-source');
            
            linkSourceId = null;
            drawConnections(lastRenderedSpatialItems);
          }
        }
      } else {
        activeDragItem = item;
        isDraggingNode = true;
        canvasNodeDragged = false;
        activeDragStart.x = item.canvas_x || 0;
        activeDragStart.y = item.canvas_y || 0;
        activeDragMouseStart.x = e.clientX;
        activeDragMouseStart.y = e.clientY;
        cardEl.classList.add('dragging');
        e.preventDefault();
      }
    } else {
      isPanning = true;
      panStart.x = e.clientX;
      panStart.y = e.clientY;
      panStartOffset.x = canvasPanX;
      panStartOffset.y = canvasPanY;
    }
  });
  
  window.addEventListener('pointermove', (e) => {
    if (isDraggingNode && activeDragItem) {
      if (Math.abs(e.clientX - activeDragMouseStart.x) > 5 || Math.abs(e.clientY - activeDragMouseStart.y) > 5) {
        canvasNodeDragged = true;
      }
      const dx = (e.clientX - activeDragMouseStart.x) / canvasZoom;
      const dy = (e.clientY - activeDragMouseStart.y) / canvasZoom;
      
      const newX = Math.round(activeDragStart.x + dx);
      const newY = Math.round(activeDragStart.y + dy);
      
      activeDragItem.canvas_x = newX;
      activeDragItem.canvas_y = newY;
      
      const cardEl = document.querySelector(`.canvas-node-card[data-id="${activeDragItem.id}"]`);
      if (cardEl) {
        cardEl.style.left = `${newX}px`;
        cardEl.style.top = `${newY}px`;
      }
      
      drawConnections(lastRenderedSpatialItems);
      updateMinimap(lastRenderedSpatialItems);
      triggerPhysicsBump(lastRenderedSpatialItems || driveFiles || []);
    } else if (isPanning) {
      canvasPanX = panStartOffset.x + (e.clientX - panStart.x);
      canvasPanY = panStartOffset.y + (e.clientY - panStart.y);
      updateCanvasTransform();
    }
  });
  
  window.addEventListener('pointerup', () => {
    if (isDraggingNode && activeDragItem) {
      const cardEl = document.querySelector(`.canvas-node-card[data-id="${activeDragItem.id}"]`);
      if (cardEl) {
        cardEl.classList.remove('dragging');
      }
      debounceSaveItem(activeDragItem);
      isDraggingNode = false;
      activeDragItem = null;
    }
    isPanning = false;
  });
  
  if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomAtCenter(1.25));
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomAtCenter(1 / 1.25));
  if (btnZoomFit) btnZoomFit.addEventListener('click', zoomToFit);
  if (btnLinkMode) btnLinkMode.addEventListener('click', toggleLinkMode);
  
  const btnViewMode = document.getElementById('btn-canvas-view-mode');
  if (btnViewMode) {
    updateCanvasViewModeButton();
    btnViewMode.addEventListener('click', () => {
      canvasViewMode = canvasViewMode === 'cards' ? 'graph' : 'cards';
      localStorage.setItem('mymind_canvas_view_mode', canvasViewMode);
      updateCanvasViewModeButton();
      renderSpatialCanvas(lastRenderedSpatialItems || driveFiles || []);
      zoomToFit();
      startPhysicsSimulation(lastRenderedSpatialItems || driveFiles || []);
      showToast(`Switched to ${canvasViewMode === 'graph' ? 'Graph' : 'Card'} View!`);
    });
  }

  const btnPhysics = document.getElementById('btn-canvas-physics');
  if (btnPhysics) {
    btnPhysics.addEventListener('click', () => {
      const items = lastRenderedSpatialItems || driveFiles || [];
      const validItems = items.filter(item => !item.isPlaceholder);
      if (validItems.length === 0) {
        showToast('No cards to arrange!');
        return;
      }
      startPhysicsSimulation(validItems);
      showToast('Running physics layout simulation...');
    });
  }
}

function startPhysicsSimulation(items, initialAlpha = 1.0) {
  const validItems = items.filter(item => !item.isPlaceholder);
  if (validItems.length === 0) return;

  console.log(`[Physics] Starting simulation for ${validItems.length} items. ViewMode: ${canvasViewMode}, Alpha: ${initialAlpha}`);

  // Initialize velocities if not present
  validItems.forEach(item => {
    if (item.vx === undefined) item.vx = 0;
    if (item.vy === undefined) item.vy = 0;
    if (physicsAnimationId === null) {
      item._initial_x = item.canvas_x || 0;
      item._initial_y = item.canvas_y || 0;
    }
  });

  physicsAlpha = Math.max(physicsAlpha, initialAlpha);

  if (physicsAnimationId) {
    return;
  }

  function tick() {
    if (physicsAlpha < 0.005) {
      physicsAnimationId = null;
      // Once settled, save positions to Google Drive (only for items that moved significantly)
      validItems.forEach(item => {
        const dx = (item.canvas_x || 0) - (item._initial_x || 0);
        const dy = (item.canvas_y || 0) - (item._initial_y || 0);
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          debounceSaveItem(item);
        }
        delete item._initial_x;
        delete item._initial_y;
      });
      return;
    }

    const isGraph = canvasViewMode === 'graph';
    // Parameters adjusted for graph vs card mode
    const repulsionStrength = isGraph ? 1500 : 8000;
    const linkStrength = isGraph ? 0.08 : 0.05;
    const tagStrength = isGraph ? 0.04 : 0.02;
    const gravityStrength = isGraph ? 0.015 : 0.01;
    const targetDistance = isGraph ? 80 : 320;
    const damping = 0.85;

    const N = validItems.length;
    const fx = new Array(N).fill(0);
    const fy = new Array(N).fill(0);

    // 1. Repulsion between all nodes
    for (let i = 0; i < N; i++) {
      const A = validItems[i];
      for (let j = i + 1; j < N; j++) {
        const B = validItems[j];
        let dx = (B.canvas_x || 0) - (A.canvas_x || 0);
        let dy = (B.canvas_y || 0) - (A.canvas_y || 0);
        if (dx === 0 && dy === 0) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
        }
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // Repulsion force
        const force = repulsionStrength / Math.max(15, dist);
        const f_x = (dx / dist) * force;
        const f_y = (dy / dist) * force;

        fx[i] -= f_x;
        fy[i] -= f_y;
        fx[j] += f_x;
        fy[j] += f_y;
      }
    }

    // 2. Attraction along connections (links)
    validItems.forEach((A, i) => {
      if (A.connections) {
        A.connections.forEach(targetId => {
          const j = validItems.findIndex(x => x.id === targetId);
          if (j !== -1) {
            const B = validItems[j];
            const dx = (B.canvas_x || 0) - (A.canvas_x || 0);
            const dy = (B.canvas_y || 0) - (A.canvas_y || 0);
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            
            // Spring force
            const diff = dist - targetDistance;
            const force = diff * linkStrength;
            const f_x = (dx / dist) * force;
            const f_y = (dy / dist) * force;

            fx[i] += f_x;
            fy[i] += f_y;
            fx[j] -= f_x;
            fy[j] -= f_y;
          }
        });
      }
    });

    // 3. Tag attraction (nodes sharing the same tag are gently pulled together)
    const ignoredTags = new Set(['inbox', 'link', 'web', 'to-read', 'todo', 'note', 'article', 'color', 'saved note']);
    for (let i = 0; i < N; i++) {
      const A = validItems[i];
      if (!A.ai_analysis || !A.ai_analysis.tags) continue;
      const tagsA = A.ai_analysis.tags.map(t => t.toLowerCase()).filter(t => !ignoredTags.has(t));
      if (tagsA.length === 0) continue;

      for (let j = i + 1; j < N; j++) {
        const B = validItems[j];
        if (!B.ai_analysis || !B.ai_analysis.tags) continue;
        const tagsB = B.ai_analysis.tags.map(t => t.toLowerCase());
        const sharedTags = tagsA.filter(t => tagsB.includes(t));
        
        if (sharedTags.length > 0) {
          const dx = (B.canvas_x || 0) - (A.canvas_x || 0);
          const dy = (B.canvas_y || 0) - (A.canvas_y || 0);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          if (dist > targetDistance) {
            const force = (dist - targetDistance) * tagStrength * sharedTags.length;
            const f_x = (dx / dist) * force;
            const f_y = (dy / dist) * force;

            fx[i] += f_x;
            fy[i] += f_y;
            fx[j] -= f_x;
            fy[j] -= f_y;
          }
        }
      }
    }

    // 4. Gravity / Centering force (pull toward origin (0, 0))
    validItems.forEach((A, i) => {
      fx[i] -= (A.canvas_x || 0) * gravityStrength;
      fy[i] -= (A.canvas_y || 0) * gravityStrength;
    });

    // 5. Update positions and velocities
    validItems.forEach((A, i) => {
      if ((activeDragItem && activeDragItem.id === A.id) || A.pinned) {
        A.vx = 0;
        A.vy = 0;
        return;
      }

      A.vx = ((A.vx || 0) + fx[i]) * damping;
      A.vy = ((A.vy || 0) + fy[i]) * damping;

      const maxStep = 45;
      const stepDist = Math.sqrt(A.vx * A.vx + A.vy * A.vy);
      if (stepDist > maxStep) {
        A.vx = (A.vx / stepDist) * maxStep;
        A.vy = (A.vy / stepDist) * maxStep;
      }

      A.canvas_x = Math.round((A.canvas_x || 0) + A.vx * physicsAlpha);
      A.canvas_y = Math.round((A.canvas_y || 0) + A.vy * physicsAlpha);
    });

    // 6. Hard Constraint: Resolve overlaps directly by shifting positions (Position Projection)
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < N; i++) {
        const A = validItems[i];
        const isAPinned = A.pinned || (activeDragItem && activeDragItem.id === A.id);
        const sizeA = getNodeSize(A, validItems);

        for (let j = i + 1; j < N; j++) {
          const B = validItems[j];
          const isBPinned = B.pinned || (activeDragItem && activeDragItem.id === B.id);
          
          if (isAPinned && isBPinned) continue; // Both are static, cannot move either

          const sizeB = getNodeSize(B, validItems);

          let dx = (B.canvas_x || 0) - (A.canvas_x || 0);
          let dy = (B.canvas_y || 0) - (A.canvas_y || 0);

          const padding = isGraph ? 15 : 40;
          const hw = (sizeA.w + sizeB.w) / 2 + padding;
          const hh = (sizeA.h + sizeB.h) / 2 + padding;

          const overlapX = hw - Math.abs(dx);
          const overlapY = hh - Math.abs(dy);

          if (overlapX > 0 && overlapY > 0) {
            // Overlapping! Push them apart along the axis of minimum penetration.
            if (dx === 0 && dy === 0) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
            }

            if (overlapX < overlapY) {
              const pushX = overlapX * Math.sign(dx);
              if (isAPinned) {
                B.canvas_x = Math.round(B.canvas_x + pushX);
                B.vx *= 0.5;
              } else if (isBPinned) {
                A.canvas_x = Math.round(A.canvas_x - pushX);
                A.vx *= 0.5;
              } else {
                A.canvas_x = Math.round(A.canvas_x - pushX / 2);
                B.canvas_x = Math.round(B.canvas_x + pushX / 2);
                A.vx *= 0.5;
                B.vx *= 0.5;
              }
            } else {
              const pushY = overlapY * Math.sign(dy);
              if (isAPinned) {
                B.canvas_y = Math.round(B.canvas_y + pushY);
                B.vy *= 0.5;
              } else if (isBPinned) {
                A.canvas_y = Math.round(A.canvas_y - pushY);
                A.vy *= 0.5;
              } else {
                A.canvas_y = Math.round(A.canvas_y - pushY / 2);
                B.canvas_y = Math.round(B.canvas_y + pushY / 2);
                A.vy *= 0.5;
                B.vy *= 0.5;
              }
            }
          }
        }
      }
    }

    // 7. Update DOM element positions
    validItems.forEach(A => {
      const cardEl = document.querySelector(`.canvas-node-card[data-id="${A.id}"]`);
      if (cardEl) {
        cardEl.style.left = `${A.canvas_x}px`;
        cardEl.style.top = `${A.canvas_y}px`;
      }
    });

    drawConnections(lastRenderedSpatialItems);
    updateMinimap(lastRenderedSpatialItems);

    physicsAlpha *= 0.96;
    physicsAnimationId = requestAnimationFrame(tick);
  }

  physicsAnimationId = requestAnimationFrame(tick);
}

function triggerPhysicsBump(items) {
  startPhysicsSimulation(items, 0.45);
}

function stopPhysicsSimulation() {
  if (physicsAnimationId) {
    cancelAnimationFrame(physicsAnimationId);
    physicsAnimationId = null;
  }
}

function updateCanvasViewModeButton() {
  const btnViewMode = document.getElementById('btn-canvas-view-mode');
  if (!btnViewMode) return;
  if (canvasViewMode === 'graph') {
    btnViewMode.classList.add('active');
    btnViewMode.textContent = '📄';
    btnViewMode.title = 'Switch to Card View';
  } else {
    btnViewMode.classList.remove('active');
    btnViewMode.textContent = '🕸️';
    btnViewMode.title = 'Switch to Graph View';
  }
}

// ============================================================================
// ==================== RAG CHAT & VECTOR SEARCH MODULE =======================
// ============================================================================

// --- 1. IndexedDB Database Wrapper ---
const MindDB = {
  dbName: 'mymind_rag_db',
  dbVersion: 1,
  db: null,

  init() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        resolve(this.db);
        return;
      }
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        reject(e);
      };
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('chunks')) {
          const chunkStore = db.createObjectStore('chunks', { keyPath: 'id' });
          chunkStore.createIndex('itemId', 'itemId', { unique: false });
        }
      };
    });
  },

  saveChunks(itemId, chunks) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      const transaction = this.db.transaction(['chunks'], 'readwrite');
      const store = transaction.objectStore('chunks');
      
      const index = store.index('itemId');
      const request = index.openCursor(IDBKeyRange.only(itemId));
      
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          if (chunks.length === 0) {
            resolve();
            return;
          }
          let count = 0;
          chunks.forEach(chunk => {
            const putReq = store.put(chunk);
            putReq.onerror = (err) => reject(err);
            putReq.onsuccess = () => {
              count++;
              if (count === chunks.length) {
                resolve();
              }
            };
          });
        }
      };
      request.onerror = (err) => reject(err);
    });
  },

  deleteChunks(itemId) {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      const transaction = this.db.transaction(['chunks'], 'readwrite');
      const store = transaction.objectStore('chunks');
      const index = store.index('itemId');
      const request = index.openCursor(IDBKeyRange.only(itemId));
      
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = (err) => reject(err);
    });
  },

  getAllChunks() {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }
      const transaction = this.db.transaction(['chunks'], 'readonly');
      const store = transaction.objectStore('chunks');
      const request = store.getAll();
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e);
    });
  }
};

// --- 2. Recursive Chunker ---
function chunkText(text, maxChunkSize = 900, overlap = 150) {
  if (!text) return [];
  const chunks = [];
  
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';
  
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    
    if (p.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      const sentences = p.match(/[^.!?]+[.!?]+/g) || [p];
      for (const sent of sentences) {
        const s = sent.trim();
        if (!s) continue;
        
        if (s.length > maxChunkSize) {
          let startPos = 0;
          while (startPos < s.length) {
            chunks.push(s.substring(startPos, startPos + maxChunkSize));
            startPos += (maxChunkSize - overlap);
          }
        } else if ((currentChunk + ' ' + s).length > maxChunkSize) {
          chunks.push(currentChunk.trim());
          const lastWords = currentChunk.substring(Math.max(0, currentChunk.length - overlap));
          currentChunk = lastWords + ' ' + s;
        } else {
          currentChunk = currentChunk ? (currentChunk + ' ' + s) : s;
        }
      }
    } else if ((currentChunk + '\n\n' + p).length > maxChunkSize) {
      chunks.push(currentChunk.trim());
      const lastChars = currentChunk.substring(Math.max(0, currentChunk.length - overlap));
      currentChunk = lastChars + '\n\n' + p;
    } else {
      currentChunk = currentChunk ? (currentChunk + '\n\n' + p) : p;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// --- 3. Embedding Vector API Call ---
async function getEmbedding(text) {
  let apiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  try {
    const response = await fetch(`/api/gemini?model=gemini-embedding-2&key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: {
          parts: [{ text: text }]
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Primary embedding request failed: ${response.statusText}`);
    }
    const data = await response.json();
    const vector = data.embedding?.values;
    if (!vector || !Array.isArray(vector)) {
      throw new Error('Malformed embedding response from primary model');
    }
    return vector;
  } catch (err) {
    console.warn('Primary embedding model (gemini-embedding-2) failed, attempting backup (text-embedding-004):', err);
    try {
      const response = await fetch(`/api/gemini?model=text-embedding-004&key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: {
            parts: [{ text: text }]
          }
        })
      });
      if (!response.ok) {
        throw new Error(`Backup embedding request failed: ${response.statusText}`);
      }
      const data = await response.json();
      const vector = data.embedding?.values;
      if (!vector || !Array.isArray(vector)) {
        throw new Error('Malformed embedding response from backup model');
      }
      return vector;
    } catch (fallbackErr) {
      console.error('Both primary and backup embedding models failed:', fallbackErr);
      throw fallbackErr;
    }
  }
}

// --- 4. Cosine Similarity Vector Search ---
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0.0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function searchVectorChunks(queryText, topK = 5) {
  const queryVector = await getEmbedding(queryText);
  const allChunks = await MindDB.getAllChunks();
  if (allChunks.length === 0) return [];
  
  const scoredChunks = allChunks.map(chunk => {
    const score = cosineSimilarity(queryVector, chunk.vector);
    return { ...chunk, score };
  });
  
  scoredChunks.sort((a, b) => b.score - a.score);
  return scoredChunks.slice(0, topK);
}

// --- 5. RAG Indexer for a Single Item ---
async function indexItemForRAG(item) {
  if (!item.rag_chunks || item.rag_chunks.length === 0) {
    if (item._drive_file_id && typeof accessToken !== 'undefined' && accessToken) {
      try {
        console.log(`[RAG debug] Downloading full file from Drive for ${item.title || item.id} to retrieve RAG chunks...`);
        const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${item._drive_file_id}?alt=media`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (contentRes.ok) {
          const remoteItem = await contentRes.json();
          if (remoteItem.rag_chunks && remoteItem.rag_chunks.length > 0) {
            console.log(`[RAG debug] Found existing RAG chunks on Drive for ${item.title || item.id}, caching locally.`);
            item.rag_chunks = remoteItem.rag_chunks;
          }
        }
      } catch (err) {
        console.warn(`[RAG debug] Failed to download remote item to check for chunks:`, err);
      }
    }
  }

  if (item.rag_chunks && item.rag_chunks.length > 0) {
    const dbChunks = item.rag_chunks.map((c, idx) => ({
      id: `${item.id}_${idx}`,
      itemId: item.id,
      text: c.text,
      vector: c.vector
    }));
    await MindDB.saveChunks(item.id, dbChunks);
    return;
  }

  let textToEmbed = '';
  
  if (item.type === 'article' && item.url) {
    let fullText = item.content.full_text || '';
    if (!fullText) {
      try {
        const scrapeRes = await fetch(`/api/scrape?url=${encodeURIComponent(item.url)}`);
        if (scrapeRes.ok) {
          const meta = await scrapeRes.json();
          fullText = meta.fullText || meta.description || '';
          item.content.full_text = fullText;
        }
      } catch (e) {
        console.error('Failed to scrape full text for RAG indexing:', e);
        fullText = item.content.raw_text || '';
      }
    }
    textToEmbed = `Title: ${item.title || 'Untitled Article'}\nURL: ${item.url}\n\n${fullText}`;
  } else {
    let contentText = item.content.raw_text || '';
    if (item.type === 'todo' && item.content.todos) {
      const todoList = item.content.todos.map(t => `- [${t.completed ? 'x' : ' '}] ${t.text}`).join('\n');
      contentText = (contentText ? contentText + '\n' : '') + todoList;
    }
    textToEmbed = `Title: ${item.title || 'Untitled Note'}\nType: ${item.type}\n\n${contentText}`;
  }

  if (!textToEmbed.trim()) return;

  const chunks = chunkText(textToEmbed);
  const ragChunks = [];
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      const vector = await getEmbedding(chunks[i]);
      ragChunks.push({
        text: chunks[i],
        vector: vector
      });
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      console.error(`Failed to generate embedding for chunk ${i} of item ${item.id}:`, e);
    }
  }

  if (ragChunks.length > 0) {
    item.rag_chunks = ragChunks;
    
    const dbChunks = ragChunks.map((c, idx) => ({
      id: `${item.id}_${idx}`,
      itemId: item.id,
      text: c.text,
      vector: c.vector
    }));
    await MindDB.saveChunks(item.id, dbChunks);
    
    if (item._drive_file_id) {
      await uploadFileContent(item._drive_file_id, item);
    }
  }
}

// --- 6. Background RAG Embeddings Indexer ---
let isEmbeddingIndexingRunning = false;

async function runBackgroundEmbeddingIndexing() {
  if (isEmbeddingIndexingRunning) return;
  
  let apiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  const email = userEmail || safeStorage.getItem('mymind_user_email');
  const isChakshu = email === 'chakshu.grover8@gmail.com';
  if (!apiKey && !isChakshu) {
    console.log('Skipping RAG indexing: Gemini key not configured.');
    return;
  }

  isEmbeddingIndexingRunning = true;
  console.log('Starting background RAG embedding indexing...');

  try {
    await MindDB.init();
  } catch (e) {
    console.error('Failed to initialize MindDB:', e);
    isEmbeddingIndexingRunning = false;
    return;
  }

  let allChunks = [];
  try {
    allChunks = await MindDB.getAllChunks();
  } catch (e) {
    console.error('Failed to read chunks from MindDB:', e);
  }
  const indexedItemIds = new Set(allChunks.map(c => c.itemId));

  // 1. Cache any newly synced items that have embeddings on Drive but aren't in IndexedDB yet
  const itemsToCache = driveFiles.filter(item => !item.isPlaceholder && item.rag_chunks && item.rag_chunks.length > 0 && !indexedItemIds.has(item.id));
  for (const item of itemsToCache) {
    try {
      const dbChunks = item.rag_chunks.map((c, idx) => ({
        id: `${item.id}_${idx}`,
        itemId: item.id,
        text: c.text,
        vector: c.vector
      }));
      await MindDB.saveChunks(item.id, dbChunks);
      indexedItemIds.add(item.id); // Mark as indexed locally
    } catch (err) {
      console.error('Failed to cache existing chunks in MindDB:', err);
    }
  }

  // 2. Filter out items that need embedding generation (no chunks locally or on Drive)
  const itemsToIndex = driveFiles.filter(item => !item.isPlaceholder && !indexedItemIds.has(item.id));
  
  if (itemsToIndex.length === 0) {
    console.log('All local items are indexed for RAG.');
    isEmbeddingIndexingRunning = false;
    return;
  }

  console.log(`Found ${itemsToIndex.length} items to index for RAG.`);
  
  for (const item of itemsToIndex) {
    try {
      console.log(`Indexing item for RAG: ${item.title || item.id}`);
      await indexItemForRAG(item);
    } catch (e) {
      console.error(`Failed to RAG-index item ${item.id}:`, e);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('Background RAG embedding indexing complete!');
  isEmbeddingIndexingRunning = false;
}

// --- 7. Chat Modal and Messaging Handlers ---
function appendChatMessage(sender, text, id = null) {
  const container = document.getElementById('chat-messages');
  if (!container) return null;
  
  const msgEl = document.createElement('div');
  msgEl.className = `chat-message ${sender}`;
  if (id) msgEl.id = id;
  
  const contentEl = document.createElement('div');
  contentEl.className = 'chat-message-content';
  contentEl.innerHTML = sender === 'ai' ? renderMarkdown(text) : text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  msgEl.appendChild(contentEl);
  
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
  return contentEl;
}

async function handleChatSubmit(e) {
  e.preventDefault();
  const inputEl = document.getElementById('chat-input');
  const query = inputEl.value.trim();
  if (!query) return;
  
  inputEl.value = '';
  appendChatMessage('user', query);
  
  const aiMessageId = 'ai-msg-' + Date.now();
  const aiMessageEl = appendChatMessage('ai', 'Thinking...', aiMessageId);
  if (aiMessageEl) aiMessageEl.classList.add('loading');
  
  console.log('[Chat debug] query:', query);
  try {
    let topChunks = [];
    if (chatFocusItem) {
      console.log('[Chat debug] Querying in focused scope for item ID:', chatFocusItem.id);
      const allChunks = await MindDB.getAllChunks();
      let itemChunks = allChunks.filter(c => c.itemId === chatFocusItem.id);
      
      if (itemChunks.length === 0) {
        console.log('[Chat debug] Card not indexed yet. Indexing now...');
        await indexItemForRAG(chatFocusItem);
        const updatedChunks = await MindDB.getAllChunks();
        itemChunks = updatedChunks.filter(c => c.itemId === chatFocusItem.id);
      }
      
      if (itemChunks.length === 0) {
        console.log('[Chat debug] Focus card contains no indexable text.');
        if (aiMessageEl) {
          aiMessageEl.classList.remove('loading');
          aiMessageEl.textContent = 'This card does not contain any text context to chat with.';
        }
        return;
      }
      
      console.log('[Chat debug] Found chunks for focused card:', itemChunks.length);
      const queryVector = await getEmbedding(query);
      topChunks = itemChunks.map(chunk => {
        const score = cosineSimilarity(queryVector, chunk.vector);
        return { ...chunk, score };
      }).sort((a, b) => b.score - a.score).slice(0, 5);
      
    } else {
      console.log('[Chat debug] Getting embedding & searching vector chunks globally...');
      topChunks = await searchVectorChunks(query, 5);
    }
    console.log('[Chat debug] topChunks selected:', topChunks.length, topChunks);
    
    if (topChunks.length === 0) {
      console.log('[Chat debug] No matching context found.');
      if (aiMessageEl) {
        aiMessageEl.classList.remove('loading');
        aiMessageEl.textContent = 'I cannot find any relevant information in your saved items. Try adding some articles or notes first!';
      }
      return;
    }
    
    const contextText = topChunks.map((chunk, idx) => {
      const item = driveFiles.find(f => f.id === chunk.itemId);
      const title = item ? item.title : 'Saved Item';
      const sourceInfo = item && item.url ? `(Source: ${title} - ${item.url})` : `(Source: ${title})`;
      return `[Chunk ${idx + 1}] ${sourceInfo}\n${chunk.text}`;
    }).join('\n\n');
    
    if (aiMessageEl) {
      aiMessageEl.textContent = '';
      aiMessageEl.classList.remove('loading');
    }
    
    let apiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
    console.log('[Chat debug] Using API Key:', apiKey ? 'YES (length: ' + apiKey.length + ')' : 'NO (empty)');
    
    const prompt = `You are a personal assistant for the user's private mindspace. Answer the user's question based ONLY on the provided context of their saved links, notes, and checklist items.
    
    CRITICAL RULES:
    1. Answer the question accurately using ONLY the context provided.
    2. If the answer cannot be determined from the context, politely say: "I couldn't find the answer in your saved items." Do not use external knowledge or make up facts.
    3. Be concise and friendly. Format key terms in bold.
    4. Reference the source names or URLs when sharing info (e.g. "According to your saved article [Title]...").
    
    Context:
    ---
    ${contextText}
    ---
    
    Question: ${query}`;

    const modelName = 'gemini-3.1-flash-lite';
    let timeoutId;
    let response;
    
    try {
      console.log(`[Chat debug] Fetching model ${modelName} with 12s timeout...`);
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 12000);
      
      response = await fetch(`/api/gemini?model=${modelName}&key=${apiKey}&stream=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      console.error('[Chat debug] Request threw error:', err);
      throw err;
    }
    
    console.log(`[Chat debug] Model ${modelName} returned status:`, response.status, response.statusText);
    if (!response.ok) {
      console.error('[Chat debug] API request failed.');
      throw new Error(`Chat API error: ${response.statusText}`);
    }
    
    console.log('[Chat debug] Response.body present?', !!response.body);
    if (!response.body) {
      const data = await response.json();
      console.log('[Chat debug] Non-streamed response data:', data);
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
      if (aiMessageEl) {
        aiMessageEl.innerHTML = renderMarkdown(text);
      }
      return;
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';
    let lastParsedIndex = 0;
    
    function parseBuffer() {
      const regex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      regex.lastIndex = lastParsedIndex;
      
      let match;
      while ((match = regex.exec(buffer)) !== null) {
        try {
          const textVal = JSON.parse(`"${match[1]}"`);
          fullText += textVal;
          if (aiMessageEl) {
            aiMessageEl.innerHTML = renderMarkdown(fullText);
          }
          const messagesContainer = document.getElementById('chat-messages');
          if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }
          lastParsedIndex = regex.lastIndex;
        } catch (e) {
          break;
        }
      }
    }
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        parseBuffer();
        break;
      }
      
      buffer += decoder.decode(value, { stream: true });
      parseBuffer();
    }
    
  } catch (err) {
    console.error('Chat error:', err);
    if (aiMessageEl) {
      aiMessageEl.classList.remove('loading');
      aiMessageEl.textContent = 'Oops, something went wrong. Make sure your Gemini API key is configured correctly in Settings.';
    }
  }
}

// --- Initializing UI Elements ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}


