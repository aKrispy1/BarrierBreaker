// All supported languages with their names and glassmorphic pastel accents
const LANGUAGE_PRESETS = [
  { code: 'ja', name: 'Japanese', accent: '#ff6b8b' },
  { code: 'es', name: 'Spanish', accent: '#ffd166' },
  { code: 'ru', name: 'Russian', accent: '#06d6a0' },
  { code: 'ar', name: 'Arabic', accent: '#118ab2' },
  { code: 'fr', name: 'French', accent: '#8338ec' },
  { code: 'de', name: 'German', accent: '#f77f00' },
  { code: 'zh', name: 'Chinese', accent: '#2ec4b6' },
  { code: 'hi', name: 'Hindi', accent: '#ff007f' }
];

const DEFAULT_LANGUAGES = LANGUAGE_PRESETS.slice(0, 5); // ja, es, ru, ar, fr

const DEFAULT_INSTANCES = [
  'https://inv.thepixora.com',
  'https://yewtu.be',
  'https://invidious.projectsegfau.lt',
  'https://invidious.flokinet.to',
  'https://invidious.privacydev.net',
  'https://invidious.lunar.icu',
  'https://invidious.fdn.fr'
];

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
    'invidiousInstances',
    'bubblesBurst',
    'maxResultsPerLang'
  ], (res) => {
    // 1. Set Power toggle
    const isEnabled = res.isEnabled !== undefined ? res.isEnabled : true;
    document.getElementById('power-toggle').checked = isEnabled;
    
    // 2. Set Stat counter
    document.getElementById('click-counter').textContent = res.bubblesBurst || 0;
    
    // 3. Set Max results
    document.getElementById('max-results').value = res.maxResultsPerLang || 2;
    
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
    
    // 5. Set Proxies Textarea
    const instances = res.invidiousInstances || DEFAULT_INSTANCES;
    document.getElementById('proxies-input').value = instances.join('\n');
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
  // 1. Get power status
  const isEnabled = document.getElementById('power-toggle').checked;
  
  // 2. Get active languages
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
  
  // 3. Get max results
  let maxResults = parseInt(document.getElementById('max-results').value, 10);
  if (isNaN(maxResults) || maxResults < 1) maxResults = 1;
  if (maxResults > 5) maxResults = 5;
  document.getElementById('max-results').value = maxResults;
  
  // 4. Get proxies
  const proxiesText = document.getElementById('proxies-input').value;
  const instances = proxiesText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && (line.startsWith('http://') || line.startsWith('https://')));
    
  if (instances.length === 0) {
    showToast('Add at least one valid HTTP proxy URL!', '#FF3B30');
    return;
  }
  
  // Save to local storage
  chrome.storage.local.set({
    isEnabled,
    activeLanguages: activeLangs,
    invidiousInstances: instances,
    maxResultsPerLang: maxResults
  }, () => {
    showToast('Configuration Saved');
  });
}

// Reset configuration to default values
function resetConfig() {
  chrome.storage.local.set({
    isEnabled: true,
    activeLanguages: DEFAULT_LANGUAGES,
    invidiousInstances: DEFAULT_INSTANCES,
    maxResultsPerLang: 2
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
  
  // Clear previous timeout if active
  if (window.toastTimeout) clearTimeout(window.toastTimeout);
  
  window.toastTimeout = setTimeout(() => {
    toast.classList.remove('visible');
  }, 1800);
}
