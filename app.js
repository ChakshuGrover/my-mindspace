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

// --- Spatial Canvas (Mind Map) Global State ---
let currentViewMode = 'grid'; // 'grid' or 'spatial'
let canvasZoom = 1;
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
const nodeSaveDebounceTimers = {};
let canvasPendingCoords = null;
let lastRenderedSpatialItems = [];

// Default credentials for sandbox testing (User can override in settings)
const DEFAULT_CLIENT_ID = '345073896444-jvm03jjn5dn6pfh95d7jbtlh4shq4ooj.apps.googleusercontent.com';

// LocalStorage Keys
const STORAGE_KEYS = {
  CLIENT_ID: 'mymind_client_id',
  GEMINI_KEY: 'mymind_gemini_key',
  ACCESS_TOKEN: 'mymind_access_token'
};

// --- Local Cache Helpers ---
function loadCachedData() {
  try {
    const cachedFolders = safeStorage.getItem('mymind_cached_folders');
    if (cachedFolders) {
      folders = JSON.parse(cachedFolders);
    }
    const cachedFiles = safeStorage.getItem('mymind_cached_files');
    if (cachedFiles) {
      driveFiles = JSON.parse(cachedFiles);
    }
  } catch (e) {
    console.error('Error loading cached data:', e);
  }
}

function saveFilesCache() {
  try {
    safeStorage.setItem('mymind_cached_files', JSON.stringify(driveFiles));
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

// --- Initializing UI Elements ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function initApp() {
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
  const savedMode = sanitizeValue(safeStorage.getItem('mymind_appearance_mode'), 'dark');
  const savedTheme = sanitizeValue(safeStorage.getItem('mymind_appearance_theme'), 'default');
  const savedOpacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');
  applyThemeAndOpacity(savedMode, savedTheme, savedOpacity);
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
  
  const btnLandingSettings = document.getElementById('btn-landing-settings');
  if (btnLandingSettings) {
    btnLandingSettings.addEventListener('click', openSettings);
  }
  
  const cancelSettings = () => {
    revertLiveSettings();
    closeModal('settings-modal');
  };
  const btnCloseSettings = document.getElementById('btn-close-settings');
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', cancelSettings);
  
  const btnCloseSettingsModal = document.getElementById('btn-close-settings-modal');
  if (btnCloseSettingsModal) btnCloseSettingsModal.addEventListener('click', cancelSettings);
  
  const settingsModalBackdrop = document.getElementById('settings-modal-backdrop');
  if (settingsModalBackdrop) settingsModalBackdrop.addEventListener('click', cancelSettings);

  // Live appearance settings changes
  const settingAppearanceMode = document.getElementById('setting-appearance-mode');
  if (settingAppearanceMode) {
    settingAppearanceMode.addEventListener('change', (e) => {
      document.documentElement.setAttribute('data-mode', e.target.value);
    });
  }
  const settingAppearanceTheme = document.getElementById('setting-appearance-theme');
  if (settingAppearanceTheme) {
    settingAppearanceTheme.addEventListener('change', (e) => {
      document.documentElement.setAttribute('data-theme', e.target.value);
    });
  }
  const settingCardOpacity = document.getElementById('setting-card-opacity');
  if (settingCardOpacity) {
    settingCardOpacity.addEventListener('input', (e) => {
      const opacityVal = (e.target.value / 100).toFixed(2);
      const settingOpacityVal = document.getElementById('setting-opacity-val');
      if (settingOpacityVal) settingOpacityVal.textContent = e.target.value + '%';
      document.documentElement.style.setProperty('--card-opacity', opacityVal);
    });
  }

  document.getElementById('btn-quick-add').addEventListener('click', () => openModal('add-modal'));
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
  
  // Set focus on inputs
  if (modalId === 'add-modal') {
    document.getElementById('add-input').focus();
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
    document.getElementById('confirm-message').textContent = message;
    
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    if (okBtn) okBtn.textContent = confirmBtnText;
    if (cancelBtn) cancelBtn.textContent = cancelBtnText;
    
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
    
    renderSidebarFolders();
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
          const item = await contentRes.json();
          item._drive_file_id = file.id;
          item._drive_modified_time = file.modifiedTime;
          if (item.type === 'color' || item.type === 'quote') {
            item.type = 'note';
          }
          return item;
        } catch (e) {
          console.error(`Error loading file content for ${file.name}:`, e);
          // If fetch fails but we have a cached copy, keep the cached copy as fallback
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
  
  const rawInputText = addInput.value.trim();
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
    title: 'Processing...',
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
  runBackgroundSave(placeholderId, rawInputText, folderId, isTodo, selectedColor);
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

async function runBackgroundSave(placeholderId, rawInputText, folderId, isTodo = false, color = 'default') {
  let pendingX = undefined;
  let pendingY = undefined;
  if (canvasPendingCoords) {
    pendingX = canvasPendingCoords.x;
    pendingY = canvasPendingCoords.y;
    canvasPendingCoords = null;
  }
  try {
    // Extract and clean the URL if present
    const cleanedUrl = !isTodo ? extractAndCleanUrl(rawInputText) : null;
    const isUrl = !!cleanedUrl;
    let aiInputText = rawInputText;
    let scrapedImage = null;
    let scrapedTitle = null;

    if (isUrl) {
      try {
        const scrapeRes = await fetch(`/api/scrape?url=${encodeURIComponent(cleanedUrl)}`);
        if (scrapeRes.ok) {
          const meta = await scrapeRes.json();
          scrapedImage = meta.image;
          scrapedTitle = meta.title;
          aiInputText = `Webpage URL: ${cleanedUrl}\nTitle: ${meta.title}\nDescription: ${meta.description}`;
        }
      } catch (e) {
        console.error('Failed to scrape URL metadata in background:', e);
      }
    }

    // 1. Run Gemma 4 31B / Gemini 3.1 Cloud analysis (Skip for To-Dos)
    let aiParsed = null;
    if (!isTodo) {
      aiParsed = await analyzeInputWithAI(aiInputText);
    }
    
    // 2. Build full metadata object
    const newItem = {
      id: 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      created_at: new Date().toISOString(),
      type: isTodo ? 'todo' : ((aiParsed && aiParsed.type === 'note' && isUrl) ? 'article' : aiParsed.type),
      title: isTodo ? (rawInputText.split('\n')[0].trim().substring(0, 40) || 'To-Do List') : (aiParsed ? (aiParsed.title || 'Saved Item') : scrapedTitle || 'Saved Item'),
      folders: folderId ? [folderId] : [],
      color: color,
      pinned: false,
      canvas_x: pendingX,
      canvas_y: pendingY,
      url: (!isTodo && aiParsed && (aiParsed.type === 'article' || isUrl)) ? (cleanedUrl || rawInputText) : '',
      image: scrapedImage || '',
      ai_analysis: (aiParsed && aiParsed.ai_analysis) || {
        summary: isTodo ? 'To-Do Checklist' : 'Saved note.',
        tags: isTodo ? ['todo'] : ['inbox'],
        vibe: 'clean',
        key_takeaways: []
      },
      content: {
        raw_text: isTodo ? rawInputText : ((aiParsed && aiParsed.content && aiParsed.content.raw_text) || rawInputText),
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

// --- Masonry Rendering Engine ---
function renderGrid() {
  const grid = document.getElementById('mind-grid');
  const emptyState = document.getElementById('empty-state');
  
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
      }
    }
    return;
  } else {
    const spatialView = document.getElementById('spatial-canvas-view');
    if (spatialView) spatialView.setAttribute('hidden', 'true');
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
            <div class="detail-body-text" style="white-space: pre-wrap;">${item.content.raw_text}</div>
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
          <div class="detail-body-text" style="white-space: pre-wrap;">${item.content.raw_text}</div>
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
  if (item.type !== 'todo') {
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
    saveFilesCache();

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

function applyThemeAndOpacity(mode, theme, opacity) {
  const root = document.documentElement;
  root.setAttribute('data-mode', sanitizeValue(mode, 'dark'));
  root.setAttribute('data-theme', sanitizeValue(theme, 'default'));
  const activeOpacity = sanitizeValue(opacity, '0.50');
  root.style.setProperty('--card-opacity', activeOpacity);
}

function initSettingsForm() {
  const geminiKey = safeStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
  const mode = sanitizeValue(safeStorage.getItem('mymind_appearance_mode'), 'dark');
  const theme = sanitizeValue(safeStorage.getItem('mymind_appearance_theme'), 'default');
  const opacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');

  const geminiInput = document.getElementById('setting-gemini-key');
  const modeInput = document.getElementById('setting-appearance-mode');
  const themeInput = document.getElementById('setting-appearance-theme');
  const opacityInput = document.getElementById('setting-card-opacity');
  const opacityVal = document.getElementById('setting-opacity-val');

  if (geminiInput) geminiInput.value = geminiKey;
  if (modeInput) modeInput.value = mode;
  if (themeInput) themeInput.value = theme;

  const parsedOpacity = parseFloat(opacity);
  const opacityPercent = isNaN(parsedOpacity) ? 50 : Math.round(parsedOpacity * 100);
  if (opacityInput) opacityInput.value = opacityPercent;
  if (opacityVal) opacityVal.textContent = opacityPercent + '%';
}

function revertLiveSettings() {
  const savedMode = sanitizeValue(safeStorage.getItem('mymind_appearance_mode'), 'dark');
  const savedTheme = sanitizeValue(safeStorage.getItem('mymind_appearance_theme'), 'default');
  const savedOpacity = sanitizeValue(safeStorage.getItem('mymind_card_opacity'), '0.50');
  applyThemeAndOpacity(savedMode, savedTheme, savedOpacity);
}

async function saveSettings(e) {
  e.preventDefault();
  const geminiKey = document.getElementById('setting-gemini-key').value.trim();
  const mode = document.getElementById('setting-appearance-mode').value;
  const theme = document.getElementById('setting-appearance-theme').value;
  const opacity = (document.getElementById('setting-card-opacity').value / 100).toFixed(2);

  safeStorage.setItem(STORAGE_KEYS.GEMINI_KEY, geminiKey);
  safeStorage.setItem('mymind_appearance_mode', mode);
  safeStorage.setItem('mymind_appearance_theme', theme);
  safeStorage.setItem('mymind_card_opacity', opacity);

  applyThemeAndOpacity(mode, theme, opacity);

  closeModal('settings-modal');
  showToast('Saving settings...');

  try {
    await syncSettingsToDrive(geminiKey, mode, theme, opacity);
    showToast('Settings saved & synced.');
  } catch (err) {
    showToast('Settings saved locally. Sync failed.');
  }
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

      if (remoteSettings.mode) {
        safeStorage.setItem('mymind_appearance_mode', sanitizeValue(remoteSettings.mode, 'dark'));
      }
      if (remoteSettings.theme) {
        safeStorage.setItem('mymind_appearance_theme', sanitizeValue(remoteSettings.theme, 'default'));
      }
      if (remoteSettings.cardOpacity) {
        safeStorage.setItem('mymind_card_opacity', sanitizeValue(remoteSettings.cardOpacity, '0.50'));
      }

      applyThemeAndOpacity(
        sanitizeValue(remoteSettings.mode, 'dark'),
        sanitizeValue(remoteSettings.theme, 'default'),
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

async function syncSettingsToDrive(geminiKey, mode, theme, opacity) {
  if (!accessToken) return;
  setSyncStatus('syncing', 'Syncing Settings...');
  try {
    const encryptionKey = googleUserId || safeStorage.getItem('mymind_google_user_id') || 'mymindspace_fallback';
    const encryptedGeminiKey = encryptKey(geminiKey, encryptionKey);

    const activeMode = sanitizeValue(mode || safeStorage.getItem('mymind_appearance_mode'), 'dark');
    const activeTheme = sanitizeValue(theme || safeStorage.getItem('mymind_appearance_theme'), 'default');
    const activeOpacity = sanitizeValue(opacity || safeStorage.getItem('mymind_card_opacity'), '0.50');

    const settingsPayload = {
      encryptedGeminiKey,
      mode: activeMode,
      theme: activeTheme,
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
  
  // 1. Draw Manual User-created Connections (Glowing solid purple curves)
  items.forEach(A => {
    if (!A.connections || A.connections.length === 0) return;
    
    const elA = document.querySelector(`.canvas-node-card[data-id="${A.id}"]`);
    if (!elA) return;
    
    const wA = elA.offsetWidth || 280;
    const hA = elA.offsetHeight || 150;
    const x1 = (A.canvas_x || 0) + wA / 2;
    const y1 = (A.canvas_y || 0) + hA / 2;
    
    A.connections.forEach(targetId => {
      const lineKey = A.id < targetId ? `${A.id}-${targetId}` : `${targetId}-${A.id}`;
      if (renderedLineKeys.has(lineKey)) return;
      
      const B = items.find(x => x.id === targetId);
      if (!B) return;
      
      const elB = document.querySelector(`.canvas-node-card[data-id="${B.id}"]`);
      if (!elB) return;
      
      const wB = elB.offsetWidth || 280;
      const hB = elB.offsetHeight || 150;
      const x2 = (B.canvas_x || 0) + wB / 2;
      const y2 = (B.canvas_y || 0) + hB / 2;
      
      const dx = x2 - x1;
      const dy = y2 - y1;
      const cx1 = x1 + dx * 0.4;
      const cy1 = y1;
      const cx2 = x2 - dx * 0.4;
      const cy2 = y2;
      
      const pathData = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
      
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('class', 'canvas-connection-line');
      path.dataset.sourceId = A.id;
      path.dataset.targetId = B.id;
      
      path.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
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
      });
      
      svg.appendChild(path);
      renderedLineKeys.add(lineKey);
    });
  });

  // 2. Draw Autoformed Semantic Connections (Soft dotted cyan curves)
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
      
      const elA = document.querySelector(`.canvas-node-card[data-id="${A.id}"]`);
      const elB = document.querySelector(`.canvas-node-card[data-id="${B.id}"]`);
      if (!elA || !elB) continue;
      
      const wA = elA.offsetWidth || 280;
      const hA = elA.offsetHeight || 150;
      const x1 = (A.canvas_x || 0) + wA / 2;
      const y1 = (A.canvas_y || 0) + hA / 2;
      
      const wB = elB.offsetWidth || 280;
      const hB = elB.offsetHeight || 150;
      const x2 = (B.canvas_x || 0) + wB / 2;
      const y2 = (B.canvas_y || 0) + hB / 2;
      
      const dx = x2 - x1;
      const dy = y2 - y1;
      const cx1 = x1 + dx * 0.4;
      const cy1 = y1;
      const cx2 = x2 - dx * 0.4;
      const cy2 = y2;
      
      const pathData = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
      
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('class', 'canvas-connection-line--auto');
      path.setAttribute('title', `Connected via shared tag(s): ${overlapTags.join(', ')}`);
      path.dataset.sourceId = A.id;
      path.dataset.targetId = B.id;
      
      path.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        showToast(`This connection is auto-formed by the shared tag: #${overlapTags[0]}. To remove it, edit the tags on either note.`);
      });
      
      svg.appendChild(path);
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

function renderSpatialCanvas(items) {
  lastRenderedSpatialItems = items;
  
  items.forEach((item, index) => {
    if (item.canvas_x === undefined || item.canvas_y === undefined) {
      const angle = 0.5 * index;
      const radius = 80 * Math.sqrt(index) + 120;
      item.canvas_x = Math.round(radius * Math.cos(angle));
      item.canvas_y = Math.round(radius * Math.sin(angle));
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
  
  viewport.addEventListener('mousedown', (e) => {
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
  
  window.addEventListener('mousemove', (e) => {
    if (isDraggingNode && activeDragItem) {
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
    } else if (isPanning) {
      canvasPanX = panStartOffset.x + (e.clientX - panStart.x);
      canvasPanY = panStartOffset.y + (e.clientY - panStart.y);
      updateCanvasTransform();
    }
  });
  
  window.addEventListener('mouseup', () => {
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
  
  viewport.addEventListener('dblclick', (e) => {
    if (e.target === viewport || e.target.id === 'spatial-canvas') {
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const canvasX = Math.round((mouseX - canvasPanX) / canvasZoom);
      const canvasY = Math.round((mouseY - canvasPanY) / canvasZoom);
      
      canvasPendingCoords = { x: canvasX, y: canvasY };
      openModal('add-modal');
    }
  });
  
  if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomAtCenter(1.25));
  if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomAtCenter(1 / 1.25));
  if (btnZoomFit) btnZoomFit.addEventListener('click', zoomToFit);
  if (btnLinkMode) btnLinkMode.addEventListener('click', toggleLinkMode);
}


