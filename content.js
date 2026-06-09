// Global variables
let lastQuery = '';
let lastUrl = '';
let isInjecting = false;
let currentVideos = [];
let activeFilters = new Set(); // Set of active language codes
let checkUrlInterval = null;
let currentPage = 1;
let isFetchingMore = false;

// Search & Sorting States
let layoutMode = 'grid'; // 'grid' or 'list'
let sortBy = 'relevance'; // 'relevance', 'views', 'date'
let durationFilter = 'any'; // 'any', 'short', 'medium', 'long'
let visibleCount = 6; // Pagination count

// Sleek Pastel SVG Logo (matches icon.svg style)
const LOGO_SVG = `
<svg class="bb-logo-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="26" height="26">
  <circle cx="68" cy="68" r="36" fill="none" stroke="rgba(255,107,139,0.3)" stroke-width="3" stroke-dasharray="6 4" />
  <circle cx="60" cy="60" r="36" fill="rgba(255,255,255,0.03)" stroke="#06d6a0" stroke-width="4" />
  <path d="M60 24v72M24 60h72" stroke="rgba(6,214,160,0.4)" stroke-width="2" />
  <path d="M35 93 L93 35" stroke="#ff6b8b" stroke-width="5" stroke-linecap="round" />
  <path d="M80 35 H93 V48" fill="none" stroke="#ff6b8b" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" />
</svg>
`;

// Helper to verify if extension context has been invalidated (e.g. extension was reloaded)
function isContextValid() {
  return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
}

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
      
      // Reset visible pagination on new search
      visibleCount = 6;
      currentPage = 1;
      isFetchingMore = false;

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
  
  // Layout Selector Toggles
  const viewToggle = document.createElement('div');
  viewToggle.className = 'bb-view-toggle';
  
  const gridBtn = document.createElement('button');
  gridBtn.className = `bb-view-btn ${layoutMode === 'grid' ? 'active' : ''}`;
  gridBtn.textContent = 'Grid';
  gridBtn.addEventListener('click', () => {
    if (layoutMode === 'grid') return;
    layoutMode = 'grid';
    gridBtn.classList.add('active');
    listBtn.classList.remove('active');
    updateGridLayout();
  });
  
  const listBtn = document.createElement('button');
  listBtn.className = `bb-view-btn ${layoutMode === 'list' ? 'active' : ''}`;
  listBtn.textContent = 'List';
  listBtn.addEventListener('click', () => {
    if (layoutMode === 'list') return;
    layoutMode = 'list';
    listBtn.classList.add('active');
    gridBtn.classList.remove('active');
    updateGridLayout();
  });
  
  viewToggle.appendChild(gridBtn);
  viewToggle.appendChild(listBtn);
  
  headerRow.appendChild(titleGroup);
  headerRow.appendChild(viewToggle);
  header.appendChild(headerRow);

  // 2. Filter & Sort controls row
  const controlsRow = document.createElement('div');
  controlsRow.className = 'bb-controls-row';

  // Language selectors list
  const filterBar = document.createElement('div');
  filterBar.className = 'bb-filter-bar';
  
  const languagesPresent = [];
  const seenLangs = new Set();
  currentVideos.forEach(v => {
    if (!seenLangs.has(v.language.code)) {
      seenLangs.add(v.language.code);
      languagesPresent.push(v.language);
    }
  });

  // Toggle all languages
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
    updateFiltersUI(filterBar);
    filterGrid();
  });
  filterBar.appendChild(allBtn);

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
      updateFiltersUI(filterBar);
      filterGrid();
    });
    
    filterBar.appendChild(btn);
  });
  controlsRow.appendChild(filterBar);

  // Sort & Search Options
  const searchOptions = document.createElement('div');
  searchOptions.className = 'bb-search-options';

  // Duration Filter Dropdown
  const durationSelect = document.createElement('select');
  durationSelect.className = 'bb-select';
  durationSelect.innerHTML = `
    <option value="any" ${durationFilter === 'any' ? 'selected' : ''}>Any Duration</option>
    <option value="short" ${durationFilter === 'short' ? 'selected' : ''}>Short (< 4m)</option>
    <option value="medium" ${durationFilter === 'medium' ? 'selected' : ''}>Medium (4-20m)</option>
    <option value="long" ${durationFilter === 'long' ? 'selected' : ''}>Long (> 20m)</option>
  `;
  durationSelect.addEventListener('change', (e) => {
    durationFilter = e.target.value;
    filterGrid();
  });

  // Sort Select Dropdown
  const sortSelect = document.createElement('select');
  sortSelect.className = 'bb-select';
  sortSelect.innerHTML = `
    <option value="relevance" ${sortBy === 'relevance' ? 'selected' : ''}>Sort: Relevance</option>
    <option value="views" ${sortBy === 'views' ? 'selected' : ''}>Sort: Most Viewed</option>
    <option value="date" ${sortBy === 'date' ? 'selected' : ''}>Sort: Newest First</option>
  `;
  sortSelect.addEventListener('change', (e) => {
    sortBy = e.target.value;
    filterGrid();
  });

  searchOptions.appendChild(durationSelect);
  searchOptions.appendChild(sortSelect);
  controlsRow.appendChild(searchOptions);
  
  header.appendChild(controlsRow);
  container.appendChild(header);

  // 3. Create Grid/List wrapper
  const grid = document.createElement('div');
  grid.className = `bb-grid ${layoutMode === 'grid' ? 'grid-view' : 'list-view'}`;
  container.appendChild(grid);

  // 4. Create Pagination footer wrapper
  const footer = document.createElement('div');
  footer.className = 'bb-show-more-container';
  container.appendChild(footer);

  // Render cards initially
  renderCards(grid, footer);
}

function updateFiltersUI(filterBar) {
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

function updateGridLayout() {
  const grid = document.querySelector('#barrier-breaker-discovery-layer .bb-grid');
  const footer = document.querySelector('#barrier-breaker-discovery-layer .bb-show-more-container');
  if (grid && footer) {
    grid.className = `bb-grid ${layoutMode === 'grid' ? 'grid-view' : 'list-view'}`;
    renderCards(grid, footer);
  }
}

function renderCards(grid, footer) {
  grid.innerHTML = '';
  footer.innerHTML = '';
  
  // 1. Language Filtering
  let processed = currentVideos.filter(v => activeFilters.has(v.language.code));
  
  // 2. Duration Filtering
  if (durationFilter !== 'any') {
    processed = processed.filter(v => {
      const len = v.lengthSeconds;
      if (durationFilter === 'short') return len > 0 && len < 240;
      if (durationFilter === 'medium') return len >= 240 && len <= 1200;
      if (durationFilter === 'long') return len > 1200;
      return true;
    });
  }

  // 3. Sorting logic
  if (sortBy === 'views') {
    processed.sort((a, b) => b.views - a.views);
  } else if (sortBy === 'date') {
    processed.sort((a, b) => a.publishedSeconds - b.publishedSeconds); // Ascending: smaller seconds = newer
  }

  // 4. Page Slicing (Pagination)
  const visibleVideos = processed.slice(0, visibleCount);

  if (visibleVideos.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 48px; font-size: 13px; color: var(--bb-text-secondary); border: 1px dashed rgba(128,128,128,0.2); border-radius: 12px; background: rgba(255,255,255,0.01);">
        No matching global videos found. Adjust your active languages or filters.
      </div>
    `;
    return;
  }

  visibleVideos.forEach(v => {
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

    // Intercept click to track stat safely
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

  // 5. Render "Show More" Pagination Button
  if (visibleCount < processed.length) {
    const showMoreBtn = document.createElement('button');
    showMoreBtn.className = 'bb-show-more-btn';
    showMoreBtn.textContent = `Show More (${processed.length - visibleCount} remaining)`;
    showMoreBtn.addEventListener('click', () => {
      visibleCount += 6;
      renderCards(grid, footer);
    });
    footer.appendChild(showMoreBtn);
  } else {
    // All locally loaded items are displayed. Show option to fetch page Y from servers
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'bb-show-more-btn';
    loadMoreBtn.textContent = `Load More Results (Page ${currentPage + 1})`;
    loadMoreBtn.addEventListener('click', () => {
      loadNextPageFromServer(grid, footer);
    });
    footer.appendChild(loadMoreBtn);
  }
}

function loadNextPageFromServer(grid, footer) {
  if (isFetchingMore) return;
  isFetchingMore = true;
  
  const loadMoreBtn = footer.querySelector('.bb-show-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.textContent = 'Loading more global results...';
    loadMoreBtn.disabled = true;
  }
  
  currentPage++;
  
  if (!isContextValid()) return;
  
  try {
    console.log(`[BarrierBreaker] Fetching page ${currentPage} from background server for query: "${lastQuery}"`);
    chrome.runtime.sendMessage({ 
      type: 'FETCH_GLOBAL_RESULTS', 
      query: lastQuery, 
      page: currentPage 
    }, (response) => {
      isFetchingMore = false;
      
      if (!isContextValid()) return;
      
      if (chrome.runtime.lastError || !response || !response.success) {
        console.warn('[BarrierBreaker] Fetch more results failed:', chrome.runtime.lastError || response?.error);
        if (loadMoreBtn) {
          loadMoreBtn.textContent = 'Failed to load. Click to retry';
          loadMoreBtn.disabled = false;
        }
        currentPage--;
        return;
      }
      
      const newVideos = response.videos || [];
      if (newVideos.length === 0) {
        if (loadMoreBtn) {
          loadMoreBtn.textContent = 'No further results available';
          loadMoreBtn.disabled = true;
        }
        return;
      }
      
      // Append and deduplicate by video ID against existing loaded videos
      const seenIds = new Set(currentVideos.map(v => v.id));
      newVideos.forEach(v => {
        if (!seenIds.has(v.id)) {
          currentVideos.push(v);
          seenIds.add(v.id);
        }
      });
      
      // Add any new languages returned on this page to activeFilters
      newVideos.forEach(v => activeFilters.add(v.language.code));
      
      // Increment visibleCount to display the new row
      visibleCount += 6;
      
      // Re-render
      renderCards(grid, footer);
    });
  } catch (err) {
    isFetchingMore = false;
    currentPage--;
    console.warn('[BarrierBreaker] Failed to request more results:', err);
  }
}

function filterGrid() {
  const grid = document.querySelector('#barrier-breaker-discovery-layer .bb-grid');
  const footer = document.querySelector('#barrier-breaker-discovery-layer .bb-show-more-container');
  if (grid && footer) {
    renderCards(grid, footer);
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
