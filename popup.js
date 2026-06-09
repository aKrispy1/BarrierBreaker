// All supported languages with their names, accents, regions, and franc ISO-639-3 codes
const LANGUAGE_PRESETS = [
  { code: 'ja', name: 'Japanese', accent: '#ff6b8b', region: 'JP', iso3: 'jpn', scripts: ['cjk'] },
  { code: 'es', name: 'Spanish', accent: '#ffd166', region: 'ES', iso3: 'spa', scripts: ['latin'] },
  { code: 'ru', name: 'Russian', accent: '#06d6a0', region: 'RU', iso3: 'rus', scripts: ['cyrillic'] },
  { code: 'ar', name: 'Arabic', accent: '#118ab2', region: 'SA', iso3: 'ara', scripts: ['arabic'] },
  { code: 'fr', name: 'French', accent: '#8338ec', region: 'FR', iso3: 'fra', scripts: ['latin'] },
  { code: 'de', name: 'German', accent: '#f77f00', region: 'DE', iso3: 'deu', scripts: ['latin'] },
  { code: 'zh', name: 'Chinese', accent: '#2ec4b6', region: 'TW', iso3: 'cmn', scripts: ['cjk'] },
  { code: 'hi', name: 'Hindi', accent: '#ff007f', region: 'IN', iso3: 'hin', scripts: ['devanagari'] }
];

const DEFAULT_LANGUAGES = LANGUAGE_PRESETS.slice(0, 5); // ja, es, ru, ar, fr

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  
  document.getElementById('save-btn').addEventListener('click', saveConfig);
  document.getElementById('reset-btn').addEventListener('click', resetConfig);
  document.getElementById('power-toggle').addEventListener('change', togglePower);
});

// Load configuration from local storage
function loadConfig() {
  chrome.storage.local.get([
    'isEnabled',
    'activeLanguages',
    'bubblesBurst',
    'maxResultsPerLang',
    'excludeEnglish'
  ], (res) => {
    // 1. Set Power toggle
    const isEnabled = res.isEnabled !== undefined ? res.isEnabled : true;
    document.getElementById('power-toggle').checked = isEnabled;
    
    // 2. Set Stat counter
    document.getElementById('click-counter').textContent = res.bubblesBurst || 0;
    
    // 3. Set Max results
    document.getElementById('max-results').value = res.maxResultsPerLang || 15;
    document.getElementById('exclude-english-toggle').checked = res.excludeEnglish || false;
    
    // 4. Render Languages List
    const activeLangs = res.activeLanguages || DEFAULT_LANGUAGES;
    const activeCodes = new Set(activeLangs.map(l => l.code));
    
    const container = document.getElementById('languages-container');
    container.innerHTML = '';
    
    LANGUAGE_PRESETS.forEach(lang => {
      const label = document.createElement('label');
      label.className = 'lang-item';
      label.style.setProperty('--lang-color', lang.accent);
      
      const isChecked = activeCodes.has(lang.code) ? 'checked' : '';
      
      label.innerHTML = `
        <input type="checkbox" class="lang-checkbox" data-code="${lang.code}" ${isChecked}>
        <span class="lang-badge" style="--lang-color: ${lang.accent}">${lang.code.toUpperCase()}</span>
        <span>${lang.name}</span>
      `;
      
      container.appendChild(label);
    });
  });
}

// Toggle enable/disable immediately
function togglePower() {
  const isEnabled = document.getElementById('power-toggle').checked;
  chrome.storage.local.set({ isEnabled }, () => {
    showToast(isEnabled ? 'Discovery Layer Enabled' : 'Discovery Layer Disabled');
  });
}

// Save configuration to storage
function saveConfig() {
  const isEnabled = document.getElementById('power-toggle').checked;
  
  // Get active languages
  const activeLangs = [];
  const checkboxes = document.querySelectorAll('.lang-checkbox');
  checkboxes.forEach(cb => {
    if (cb.checked) {
      const code = cb.getAttribute('data-code');
      const preset = LANGUAGE_PRESETS.find(p => p.code === code);
      if (preset) activeLangs.push(preset);
    }
  });

  if (activeLangs.length === 0) {
    showToast('Select at least one language!', '#FF3B30');
    return;
  }
  
  // Get max results
  let maxResults = parseInt(document.getElementById('max-results').value, 10);
  if (isNaN(maxResults) || maxResults < 1) maxResults = 1;
  if (maxResults > 50) maxResults = 50;
  document.getElementById('max-results').value = maxResults;
  
  const excludeEnglish = document.getElementById('exclude-english-toggle').checked;
  
  // Save to local storage
  chrome.storage.local.set({
    isEnabled,
    activeLanguages: activeLangs,
    maxResultsPerLang: maxResults,
    excludeEnglish
  }, () => {
    showToast('Configuration Saved');
  });
}

// Reset configuration to default values
function resetConfig() {
  chrome.storage.local.set({
    isEnabled: true,
    activeLanguages: DEFAULT_LANGUAGES,
    maxResultsPerLang: 15,
    excludeEnglish: false
  }, () => {
    showToast('Reset to Defaults');
    setTimeout(() => {
      window.location.reload();
    }, 500);
  });
}

// Helper to show a feedback toast
function showToast(message, color = '#06d6a0') {
  const toast = document.getElementById('status-toast');
  toast.textContent = message;
  toast.style.color = color;
  toast.classList.add('visible');
  
  if (window.toastTimeout) clearTimeout(window.toastTimeout);
  
  window.toastTimeout = setTimeout(() => {
    toast.classList.remove('visible');
  }, 1800);
}
