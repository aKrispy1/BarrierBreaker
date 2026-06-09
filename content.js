// Global variables
let lastQuery = '';
let lastUrl = '';
let isInjecting = false;
let currentVideos = [];
let activeFilters = new Set(); // Set of active language codes
let checkUrlInterval = null;

// Helper to verify if extension context has been invalidated (e.g. extension was reloaded)
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}

// Sleek Pastel SVG Logo (matches icon.svg style)
const LOGO_SVG = `
<svg class="bb-logo-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28">
  <circle cx="68" cy="68" r="36" fill="none" stroke="rgba(255,107,139,0.3)" stroke-width="3" stroke-dasharray="6 4" />
  <circle cx="60" cy="60" r="36" fill="rgba(255,255,255,0.03)" stroke="#06d6a0" stroke-width="4" />
  <path d="M60 24v72M24 60h72" stroke="rgba(6,214,160,0.4)" stroke-width="2" />
  <path d="M35 93 L93 35" stroke="#ff6b8b" stroke-width="5" stroke-linecap="round" />
  <path d="M80 35 H93 V48" fill="none" stroke="#ff6b8b" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" />
</svg>
`;

// Start checking URL changes
function init() {
  checkUrlInterval = setInterval(checkUrl, 1000);
  checkUrl(); // Run immediately
}

function checkUrl() {
  if (!isContextValid()) {
    console.warn('[BarrierBreaker] Extension context invalidated. Terminating routing loop. Please reload the YouTube page.');
    if (checkUrlInterval) clearInterval(checkUrlInterval);
    return;
  }

  const url = window.location.href;

  if (url.includes('/results') && url.includes('search_query=')) {
    const urlParams = new URLSearchParams(window.location.search);
    const query = urlParams.get('search_query');
    const existing = document.getElementById('barrier-breaker-discovery-layer');
    
    // Trigger injection if:
    // 1. The query string has changed
    // 2. The page URL has changed
    // 3. Or the container has been wiped out from the DOM by YouTube's SPA router
    if (query && (query !== lastQuery || url !== lastUrl || !existing)) {
      lastQuery = query;
      lastUrl = url;
      setupDiscoveryLayer(query);
    }
  } else {
    // If we moved away from search results, clean up
    if (url !== lastUrl) {
      removeDiscoveryLayer();
      lastQuery = '';
      lastUrl = url;
    }
  }
}

function removeDiscoveryLayer() {
  const existing = document.getElementById('barrier-breaker-discovery-layer');
  if (existing) existing.remove();
}

async function setupDiscoveryLayer(query) {
  if (!isContextValid()) return;
  if (isInjecting) return;
  isInjecting = true;
  
  // Clean up any stale discovery layers
  removeDiscoveryLayer();

  console.log(`[BarrierBreaker] Intercepted query: "${query}". Initiating global search.`);

  // Wait for the container to appear in the DOM
  // We target the main results column #primary inside ytd-search (Desktop)
  const targetSelector = 'ytd-search #primary';
  let parent = document.querySelector(targetSelector);
  
  // Polling for container up to 10 seconds
  let attempts = 0;
  while (!parent && attempts < 20) {
    await new Promise(r => setTimeout(r, 500));
    if (!isContextValid()) return;
    parent = document.querySelector(targetSelector);
    attempts++;
  }

  // Fallback selector for mobile or slightly different layout
  if (!parent) {
    parent = document.querySelector('#primary') || 
             document.querySelector('ytd-search') ||
             document.querySelector('#contents') ||
             document.querySelector('body');
  }

  if (!parent) {
    console.error('[BarrierBreaker] Target injection container not found. Aborting.');
    isInjecting = false;
    return;
  }

  // Create discovery layer container
  const container = document.createElement('div');
  container.id = 'barrier-breaker-discovery-layer';
  container.className = 'bb-container';
  
  // Render loading state
  container.innerHTML = `
    <div class="bb-loader">
      <div class="bb-loading-text">Bursting your algorithmic bubble...</div>
      <div class="bb-loading-bar-container">
        <div class="bb-loading-bar"></div>
      </div>
      <div style="font-size: 11px; color: var(--bb-text-secondary); margin-top: 14px; opacity: 0.8;">
        Translating query to regional languages & routing via decentralized proxy nodes
      </div>
    </div>
  `;

  // Inject container: place it right below the search header filters if available,
  // otherwise at the very top of the primary column.
  const searchHeader = parent.querySelector('ytd-search-header-renderer');
  if (searchHeader && searchHeader.nextSibling) {
    parent.insertBefore(container, searchHeader.nextSibling);
  } else if (parent.firstChild) {
    parent.insertBefore(container, parent.firstChild);
  } else {
    parent.appendChild(container);
  }

  // Request results from background script with try-catch validation
  try {
    if (!isContextValid()) return;
    chrome.runtime.sendMessage({ type: 'FETCH_GLOBAL_RESULTS', query: query }, (response) => {
      isInjecting = false;
      
      if (!isContextValid()) return;
      
      if (chrome.runtime.lastError) {
        renderError(container, `Extension communication error: ${chrome.runtime.lastError.message}`);
        return;
      }
      
      if (!response || response.disabled) {
        removeDiscoveryLayer();
        return;
      }
      
      if (!response.success) {
        renderError(container, response.error || 'Unknown error occurred while fetching results.');
        return;
      }
      
      currentVideos = response.videos || [];
      
      if (currentVideos.length === 0) {
        renderEmpty(container);
        return;
      }

      // Populate active filters with all returned languages
      activeFilters.clear();
      currentVideos.forEach(v => activeFilters.add(v.language.code));

      renderDiscoveryGrid(container);
    });
  } catch (err) {
    isInjecting = false;
    console.warn('[BarrierBreaker] Send message failed, extension context likely invalidated:', err.message);
    if (err.message.includes('Extension context invalidated')) {
      if (checkUrlInterval) clearInterval(checkUrlInterval);
    }
  }
}

function renderError(container, errorMsg) {
  container.innerHTML = `
    <div class="bb-header">
      <div class="bb-header-row">
        <div class="bb-title-group">
          ${LOGO_SVG}
          <h2 class="bb-title">BarrierBreaker // Error</h2>
        </div>
      </div>
    </div>
    <div class="bb-error-message">
      Failed to burst bubble: ${errorMsg}
    </div>
  `;
}

function renderEmpty(container) {
  container.innerHTML = `
    <div class="bb-header">
      <div class="bb-header-row">
        <div class="bb-title-group">
          ${LOGO_SVG}
          <h2 class="bb-title">BarrierBreaker // No Results</h2>
        </div>
      </div>
    </div>
    <div style="text-align: center; padding: 24px; font-size: 13px; color: var(--bb-text-secondary); opacity: 0.8;">
      All proxy instances returned empty results. Try adjustments in the extension configuration.
    </div>
  `;
}

function renderDiscoveryGrid(container) {
  // Clear container
  container.innerHTML = '';

  // 1. Create Header
  const header = document.createElement('div');
  header.className = 'bb-header';
  
  const headerRow = document.createElement('div');
  headerRow.className = 'bb-header-row';
  
  const titleGroup = document.createElement('div');
  titleGroup.className = 'bb-title-group';
  titleGroup.innerHTML = `
    ${LOGO_SVG}
    <div>
      <h2 class="bb-title">BarrierBreaker // Sovereign Global Feed</h2>
      <div class="bb-subtitle">Surfacing language-agnostic perspectives bypassed by standard localization biases</div>
    </div>
  `;
  
  headerRow.appendChild(titleGroup);
  header.appendChild(headerRow);

  // 2. Create Language Filter Bar
  const filterBar = document.createElement('div');
  filterBar.className = 'bb-filter-bar';
  
  // Get unique languages present in our video list
  const languagesPresent = [];
  const seenLangs = new Set();
  currentVideos.forEach(v => {
    if (!seenLangs.has(v.language.code)) {
      seenLangs.add(v.language.code);
      languagesPresent.push(v.language);
    }
  });

  // "Toggle All" button
  const allBtn = document.createElement('button');
  allBtn.className = 'bb-filter-btn';
  allBtn.textContent = 'Toggle All';
  allBtn.addEventListener('click', () => {
    const allActive = activeFilters.size === languagesPresent.length;
    if (allActive) {
      activeFilters.clear();
    } else {
      languagesPresent.forEach(l => activeFilters.add(l.code));
    }
    updateFiltersUI(filterBar, languagesPresent);
    filterGrid();
  });
  filterBar.appendChild(allBtn);

  // Individual language filter buttons
  languagesPresent.forEach(lang => {
    const btn = document.createElement('button');
    btn.className = `bb-filter-btn bb-lang-${lang.code} ${activeFilters.has(lang.code) ? 'active' : ''}`;
    btn.textContent = lang.name;
    btn.setAttribute('data-lang', lang.code);
    
    btn.addEventListener('click', () => {
      if (activeFilters.has(lang.code)) {
        activeFilters.delete(lang.code);
      } else {
        activeFilters.add(lang.code);
      }
      updateFiltersUI(filterBar, languagesPresent);
      filterGrid();
    });
    
    filterBar.appendChild(btn);
  });
  
  header.appendChild(filterBar);
  container.appendChild(header);

  // 3. Create Grid
  const grid = document.createElement('div');
  grid.className = 'bb-grid';
  container.appendChild(grid);

  // Render cards
  renderCards(grid);
}

function updateFiltersUI(filterBar, languagesPresent) {
  const buttons = filterBar.querySelectorAll('.bb-filter-btn[data-lang]');
  buttons.forEach(btn => {
    const code = btn.getAttribute('data-lang');
    if (activeFilters.has(code)) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function renderCards(grid) {
  grid.innerHTML = '';
  
  const filteredVideos = currentVideos.filter(v => activeFilters.has(v.language.code));
  
  if (filteredVideos.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; font-size: 13px; color: var(--bb-text-secondary); border: 1px dashed rgba(128,128,128,0.2); border-radius: 12px; background: rgba(255,255,255,0.01);">
        No languages selected. Select languages in the toolbar above to inspect content.
      </div>
    `;
    return;
  }

  filteredVideos.forEach(v => {
    const card = document.createElement('a');
    card.href = `/watch?v=${v.id}`;
    card.className = `bb-card bb-lang-${v.language.code}`;
    card.setAttribute('data-id', v.id);

    // Display title logic: show translated title primarily, original title as subtitle
    const displayTitle = v.translatedTitle || v.originalTitle;
    const subTitleMarkup = v.translatedTitle ? `<div class="bb-original-title">${v.originalTitle}</div>` : '';

    card.innerHTML = `
      <div class="bb-thumb-wrapper">
        <img class="bb-thumb-img" src="${v.thumbnail}" alt="${v.originalTitle}" loading="lazy">
        <div class="bb-lang-badge">${v.language.name}</div>
        ${v.lengthText ? `<div class="bb-duration">${v.lengthText}</div>` : ''}
      </div>
      <div class="bb-details">
        <h3 class="bb-video-title">${displayTitle}</h3>
        ${subTitleMarkup}
        <div class="bb-channel">${v.author}</div>
        <div class="bb-meta-row">
          <span>${v.viewsText ? `${v.viewsText} • ` : ''}${v.publishedText}</span>
          <span class="bb-proxy-info">${parseHostname(v.instanceUsed)}</span>
        </div>
      </div>
    `;

    // Intercept click to track stat
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const targetUrl = `/watch?v=${v.id}`;
      if (isContextValid()) {
        try {
          chrome.runtime.sendMessage({ type: 'TRACK_CLICK' }, () => {
            window.location.href = targetUrl;
          });
        } catch (err) {
          window.location.href = targetUrl;
        }
      } else {
        window.location.href = targetUrl;
      }
    });

    grid.appendChild(card);
  });
}

function filterGrid() {
  const grid = document.querySelector('#barrier-breaker-discovery-layer .bb-grid');
  if (grid) {
    renderCards(grid);
  }
}

// Helpers
function parseHostname(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch (e) {
    return 'proxy';
  }
}

// Start Content Script
init();
