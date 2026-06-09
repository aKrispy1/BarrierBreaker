// Default settings
const DEFAULT_LANGUAGES = [
  { code: 'ja', name: 'Japanese', accent: '#ff6b8b' },
  { code: 'es', name: 'Spanish', accent: '#ffd166' },
  { code: 'ru', name: 'Russian', accent: '#06d6a0' },
  { code: 'ar', name: 'Arabic', accent: '#118ab2' },
  { code: 'fr', name: 'French', accent: '#8338ec' }
];

const DEFAULT_INSTANCES = [
  'https://inv.thepixora.com',
  'https://yewtu.be',
  'https://invidious.projectsegfau.lt',
  'https://invidious.flokinet.to',
  'https://invidious.privacydev.net',
  'https://invidious.lunar.icu',
  'https://invidious.fdn.fr'
];

const RULE_ID = 1;

async function setupHeaderRules() {
  try {
    const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    const oldRuleIds = oldRules.map(r => r.id);
    
    const rules = [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "remove" },
            { header: "referer", operation: "remove" },
            { header: "user-agent", operation: "set", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36" }
          ]
        },
        condition: {
          urlFilter: "*",
          domains: [
            "translate.googleapis.com", 
            "yewtu.be", 
            "invidious.projectsegfau.lt", 
            "invidious.flokinet.to", 
            "invidious.privacydev.net", 
            "invidious.lunar.icu", 
            "invidious.fdn.fr"
          ],
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldRuleIds,
      addRules: rules
    });
    console.log("[BarrierBreaker] Header bypass rules registered.");
  } catch (err) {
    console.warn("Failed registering declarativeNetRequest rules:", err);
  }
}

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(() => {
  setupHeaderRules();
  chrome.storage.local.get(['activeLanguages', 'invidiousInstances', 'bubblesBurst', 'isEnabled', 'maxResultsPerLang'], (res) => {
    const updates = {};
    if (!res.activeLanguages) updates.activeLanguages = DEFAULT_LANGUAGES;
    if (!res.invidiousInstances) updates.invidiousInstances = DEFAULT_INSTANCES;
    if (res.bubblesBurst === undefined) updates.bubblesBurst = 0;
    if (res.isEnabled === undefined) updates.isEnabled = true;
    if (!res.maxResultsPerLang) updates.maxResultsPerLang = 2;
    
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  setupHeaderRules();
});

// Translation Helper
async function translateText(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data[0] && data[0][0] && data[0][0][0]) {
      return data[0][0][0];
    }
    throw new Error('Invalid structure');
  } catch (err) {
    console.error(`Translation error (${from} -> ${to}):`, err);
    return text; // Return original text on failure
  }
}

// Fetch results from a specific Invidious instance
async function fetchInvidiousResults(instance, query, langCode) {
  const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&hl=${langCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${instance}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Invalid data type from ${instance}`);
  return data;
}

// Handle execution of localized search
async function processGlobalSearch(searchQuery) {
  // 1. Get configurations
  const store = await new Promise((resolve) => {
    chrome.storage.local.get(['activeLanguages', 'invidiousInstances', 'maxResultsPerLang', 'excludeEnglish'], resolve);
  });
  
  const activeLangs = store.activeLanguages || DEFAULT_LANGUAGES;
  const instances = store.invidiousInstances || DEFAULT_INSTANCES;
  const maxResults = store.maxResultsPerLang || 2;
  const excludeEnglish = store.excludeEnglish || false;
  
  if (activeLangs.length === 0) return [];

  // 2. Perform translations in parallel
  console.log(`Translating query: "${searchQuery}"`);
  const translationPromises = activeLangs.map(async (lang) => {
    try {
      const translated = await translateText(searchQuery, 'en', lang.code);
      return { lang, translated };
    } catch (e) {
      return { lang, translated: searchQuery }; // Fallback to english
    }
  });
  
  const translations = await Promise.all(translationPromises);
  
  // 3. Concurrently fetch search results from rotating Invidious instances
  // We balance the instances across the active languages
  const fetchPromises = translations.map(async ({ lang, translated }, index) => {
    // Pick an instance from the list based on rotation
    const primaryInstanceIdx = index % instances.length;
    let success = false;
    let items = [];
    let usedInstance = '';
    
    // Try primary instance, then try fallbacks if it fails
    for (let i = 0; i < Math.min(3, instances.length); i++) {
      const instanceIdx = (primaryInstanceIdx + i) % instances.length;
      const instance = instances[instanceIdx];
      try {
        console.log(`Querying "${translated}" [${lang.name}] on ${instance}`);
        items = await fetchInvidiousResults(instance, translated, lang.code);
        usedInstance = instance;
        success = true;
        break;
      } catch (err) {
        console.warn(`Failed querying ${instance} for ${lang.name}:`, err.message);
      }
    }
    
    if (!success) {
      console.error(`All attempts failed for language ${lang.name}`);
      return [];
    }

    // Filter and slice items
    const videos = items
      .filter(item => item.type === 'video' && item.videoId)
      .slice(0, maxResults)
      .map(v => {
        // Find best thumbnail URL
        let thumbnail = '';
        if (v.videoThumbnails && v.videoThumbnails.length > 0) {
          // Find the highest resolution thumbnail (usually last or has highest width)
          const sortedThumbs = [...v.videoThumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
          thumbnail = sortedThumbs[0].url;
        } else {
          thumbnail = `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`;
        }
        
        // Ensure thumbnail URL has https/absolute format
        if (thumbnail.startsWith('//')) {
          thumbnail = 'https:' + thumbnail;
        } else if (thumbnail.startsWith('/')) {
          thumbnail = usedInstance + thumbnail;
        }
        
        return {
          id: v.videoId,
          title: v.title,
          originalTitle: v.title,
          translatedTitle: '', // will be populated
          author: v.author,
          authorUrl: v.authorUrl || `https://www.youtube.com/channel/${v.authorId}`,
          lengthText: v.lengthSeconds ? formatDuration(v.lengthSeconds) : '',
          viewsText: v.viewCount ? formatViews(v.viewCount) : '',
          publishedText: v.publishedText || '',
          language: lang,
          queryUsed: translated,
          instanceUsed: usedInstance
        };
      });

    // Translate titles back to English in parallel
    const titleTranslationPromises = videos.map(async (v) => {
      if (lang.code !== 'en') {
        try {
          const translatedTitle = await translateText(v.originalTitle, lang.code, 'en');
          if (translatedTitle !== v.originalTitle) {
            v.translatedTitle = translatedTitle;
          }
        } catch (e) {
          console.warn(`Failed translating title back to English:`, e);
        }
      }
      return v;
    });

    return Promise.all(titleTranslationPromises);
  });

  const resultsByLang = await Promise.all(fetchPromises);
  
  // Aggregate and flatten
  let aggregatedResults = resultsByLang.flat();
  
  // Exclude English videos if configured
  if (excludeEnglish) {
    aggregatedResults = aggregatedResults.filter(v => {
      // If original language is not English, but back-translation to English resulted in no change 
      // (v.translatedTitle is empty), we classify it as an English video.
      if (v.language.code !== 'en' && !v.translatedTitle) {
        return false;
      }
      return true;
    });
  }
  
  // Deduplicate by video ID just in case
  const seenIds = new Set();
  const deduplicated = aggregatedResults.filter(v => {
    if (seenIds.has(v.id)) return false;
    seenIds.add(v.id);
    return true;
  });

  return deduplicated;
}

// Format duration helper (seconds -> HH:MM:SS or MM:SS)
function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(h);
  parts.push(m.toString().padStart(h > 0 ? 2 : 1, '0'));
  parts.push(s.toString().padStart(2, '0'));
  return parts.join(':');
}

// Format view counts helper
function formatViews(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M views';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K views';
  }
  return num + ' views';
}

// Listener for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_GLOBAL_RESULTS') {
    chrome.storage.local.get('isEnabled', (store) => {
      const isEnabled = store.isEnabled !== false;
      if (!isEnabled) {
        sendResponse({ success: true, videos: [], disabled: true });
        return;
      }
      processGlobalSearch(message.query)
        .then(videos => {
          sendResponse({ success: true, videos });
        })
        .catch(err => {
          console.error('Failed processing global search:', err);
          sendResponse({ success: false, error: err.message });
        });
    });
    return true; // Keep message channel open for async response
  }
  
  if (message.type === 'TRACK_CLICK') {
    chrome.storage.local.get('bubblesBurst', (res) => {
      const current = res.bubblesBurst || 0;
      chrome.storage.local.set({ bubblesBurst: current + 1 }, () => {
        sendResponse({ success: true, count: current + 1 });
      });
    });
    return true;
  }
});
