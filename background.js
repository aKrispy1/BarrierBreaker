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
    if (!res.maxResultsPerLang) updates.maxResultsPerLang = 10;
    
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });
});

// Helper to convert relative publish time (e.g. "3 days ago") to seconds for sorting
function parsePublishedTextToSeconds(text) {
  if (!text) return 9999999999;
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
  if (!match) return 9999999999;
  const val = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  let multiplier = 1;
  if (unit.startsWith('minute')) multiplier = 60;
  else if (unit.startsWith('hour')) multiplier = 3600;
  else if (unit.startsWith('day')) multiplier = 86400;
  else if (unit.startsWith('week')) multiplier = 604800;
  else if (unit.startsWith('month')) multiplier = 2592000;
  else if (unit.startsWith('year')) multiplier = 31536000;
  return val * multiplier;
}

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
async function fetchInvidiousResults(instance, query, langCode, page = 1) {
  const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&hl=${langCode}&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${instance}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Invalid data type from ${instance}`);
  return data;
}

// Keyword relevance filter to remove dictionary translation errors (like brand names being translated to common words)
function filterByRelevance(videos, originalQuery, translatedQuery) {
  const stopWords = new Set(['the', 'and', 'a', 'of', 'in', 'to', 'for', 'is', 'with', 'on', 'at', 'by', 'an']);
  
  // Extract search keywords, ignoring short words and symbols
  const getKeywords = (q) => {
    if (!q) return [];
    return q.toLowerCase()
      .split(/[\s,.\-\/]+/)
      .map(w => w.replace(/[^\w\s\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u0400-\u04ff]/g, '').trim())
      .filter(w => w.length >= 2 && !stopWords.has(w));
  };

  const originalKeywords = getKeywords(originalQuery);
  const translatedKeywords = getKeywords(translatedQuery);
  
  // If we have no keywords (e.g. search was empty or too short), don't filter
  if (originalKeywords.length === 0 && translatedKeywords.length === 0) return videos;

  return videos.filter(v => {
    const titleLower = v.title.toLowerCase();
    const transTitleLower = (v.translatedTitle || '').toLowerCase();
    const channelLower = v.author.toLowerCase();
    
    // Check if original keywords are in the video title or channel name
    const matchesOriginal = originalKeywords.some(kw => 
      titleLower.includes(kw) || 
      transTitleLower.includes(kw) || 
      channelLower.includes(kw)
    );
    
    // Check if translated keywords are in the video title or channel name
    const matchesTranslated = translatedKeywords.some(kw => 
      titleLower.includes(kw) || 
      transTitleLower.includes(kw) || 
      channelLower.includes(kw)
    );

    return matchesOriginal || matchesTranslated;
  });
}

// Handle execution of localized search
async function processGlobalSearch(searchQuery, page = 1) {
  // 1. Get configurations
  const store = await new Promise((resolve) => {
    chrome.storage.local.get(['activeLanguages', 'invidiousInstances', 'maxResultsPerLang', 'excludeEnglish'], resolve);
  });
  
  const activeLangs = store.activeLanguages || DEFAULT_LANGUAGES;
  const instances = store.invidiousInstances || DEFAULT_INSTANCES;
  const maxResults = store.maxResultsPerLang || 10;
  const excludeEnglish = store.excludeEnglish || false;
  
  if (activeLangs.length === 0) return [];

  // 2. Perform translations in parallel
  console.log(`[BarrierBreaker] Translating query: "${searchQuery}"`);
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
    const primaryInstanceIdx = index % instances.length;
    let success = false;
    let rawItems = [];
    let usedInstance = '';

    // We query both: the translated query AND the original English query
    // This solves brand name/proper noun translation errors (e.g. searching "Valorant" in Japan)
    const queriesToTry = [translated];
    if (translated.toLowerCase() !== searchQuery.toLowerCase()) {
      queriesToTry.push(searchQuery);
    }
    
    // Try primary instance, then try fallbacks if it fails
    for (let i = 0; i < Math.min(3, instances.length); i++) {
      const instanceIdx = (primaryInstanceIdx + i) % instances.length;
      const instance = instances[instanceIdx];
      try {
        console.log(`[BarrierBreaker] Fetching page ${page} for ${lang.name} using ${instance}`);
        
        // Fetch queries concurrently from the same instance
        const results = await Promise.all(queriesToTry.map(q => 
          fetchInvidiousResults(instance, q, lang.code, page)
            .catch(e => {
              console.warn(`Query "${q}" failed on ${instance}:`, e.message);
              return [];
            })
        ));
        
        // Merge and flatten
        rawItems = results.flat();
        usedInstance = instance;
        success = true;
        break;
      } catch (err) {
        console.warn(`Failed querying ${instance} for ${lang.name}:`, err.message);
      }
    }
    
    if (!success || rawItems.length === 0) {
      console.error(`All attempts failed for language ${lang.name}`);
      return [];
    }

    // Format items
    const videos = rawItems
      .filter(item => item.type === 'video' && item.videoId)
      .map(v => {
        return {
          id: v.videoId,
          title: v.title,
          originalTitle: v.title,
          translatedTitle: '', // will be populated
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`, // Official YouTube CDN (Bypasses CSP blocks)
          author: v.author,
          authorUrl: v.authorUrl || `https://www.youtube.com/channel/${v.authorId}`,
          lengthText: v.lengthSeconds ? formatDuration(v.lengthSeconds) : '',
          lengthSeconds: v.lengthSeconds || 0,
          viewsText: v.viewCount ? formatViews(v.viewCount) : '',
          views: v.viewCount || 0, // numeric views for sorting
          publishedText: v.publishedText || '',
          publishedSeconds: parsePublishedTextToSeconds(v.publishedText), // numeric age for sorting
          language: lang,
          queryUsed: translated,
          instanceUsed: usedInstance
        };
      });

    // Deduplicate within this language list by video ID
    const seenLocalIds = new Set();
    const uniqueVideos = videos.filter(v => {
      if (seenLocalIds.has(v.id)) return false;
      seenLocalIds.add(v.id);
      return true;
    });

    // Translate video titles back to English in a single batch request
    if (lang.code !== 'en' && uniqueVideos.length > 0) {
      try {
        const textToTranslate = uniqueVideos.map(v => v.originalTitle).join('\n');
        const translatedText = await translateText(textToTranslate, lang.code, 'en');
        const translatedTitles = translatedText.split('\n').map(t => t.trim());
        
        if (translatedTitles.length === uniqueVideos.length) {
          uniqueVideos.forEach((v, idx) => {
            const trans = translatedTitles[idx];
            if (trans && trans.toLowerCase() !== v.originalTitle.toLowerCase()) {
              v.translatedTitle = trans;
            }
          });
        } else {
          // Fallback to individual translations if counts mismatch
          console.warn(`[BarrierBreaker] Batch translation count mismatch (${translatedTitles.length} vs ${uniqueVideos.length}). Using fallbacks.`);
          await Promise.all(uniqueVideos.map(async (v) => {
            try {
              const trans = await translateText(v.originalTitle, lang.code, 'en');
              if (trans && trans.toLowerCase() !== v.originalTitle.toLowerCase()) {
                v.translatedTitle = trans;
              }
            } catch (e) {
              console.warn(`Failed translating title:`, e);
            }
          }));
        }
      } catch (err) {
        console.warn(`Failed batch translating titles for ${lang.name}:`, err);
      }
    }

    // Apply strict relevance filtering to screen out translation mistakes
    const relevantVideos = filterByRelevance(uniqueVideos, searchQuery, translated);

    // Slice to max results after filtering to ensure we don't truncate early
    return relevantVideos.slice(0, maxResults);
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
      const page = message.page || 1;
      processGlobalSearch(message.query, page)
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
