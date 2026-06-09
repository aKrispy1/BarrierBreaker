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

// Track globally seen video IDs to prevent cross-page duplicates
let globalSeenIds = new Set();
let lastSearchQuery = '';

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
            "invidious.fdn.fr",
            "inv.thepixora.com"
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
    if (!res.maxResultsPerLang) updates.maxResultsPerLang = 15;
    
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  setupHeaderRules();
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

// Translation Helper
async function translateText(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Concatenate all translation segments
    if (data && data[0]) {
      return data[0]
        .filter(seg => seg && seg[0])
        .map(seg => seg[0])
        .join('');
    }
    throw new Error('Invalid structure');
  } catch (err) {
    console.error(`Translation error (${from} -> ${to}):`, err);
    return text; // Return original text on failure
  }
}

// Detect if a query is likely a proper noun/brand name that shouldn't be translated
function isLikelyProperNoun(original, translated) {
  const origLower = original.trim().toLowerCase();
  const transLower = translated.trim().toLowerCase();
  
  // If the translation is identical to the original (or near-identical), it's a proper noun
  // that the translator didn't change
  if (origLower === transLower) return true;
  
  // If the original is a single word and gets translated to something completely different,
  // it's likely a proper noun being mistranslated (e.g., "Valorant" -> "勇敢な")
  const origWords = origLower.split(/\s+/).filter(w => w.length > 0);
  if (origWords.length === 1 && origLower.length > 3) {
    // Check if translated text contains no latin characters at all — likely a dictionary translation
    const hasLatin = /[a-zA-Z]/.test(translated);
    if (!hasLatin) return true;
  }
  
  return false;
}

// Fetch results from a specific Invidious instance with timeout
async function fetchInvidiousResults(instance, query, langCode, page = 1) {
  const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&hl=${langCode}&page=${page}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000); // 12 second timeout
  
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${instance}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(`Invalid data type from ${instance}`);
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Detect English content by analyzing the title text
function isLikelyEnglish(title) {
  if (!title || title.length === 0) return false;
  
  // Count Latin characters vs total characters (excluding spaces, numbers, symbols)
  const letters = title.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length === 0) return false;
  
  const latinChars = (letters.match(/[a-zA-Z]/g) || []).length;
  const latinRatio = latinChars / letters.length;
  
  // If >85% of letter characters are Latin, likely English
  // This catches English titles even on non-English Invidious instances
  return latinRatio > 0.85;
}

// Keyword relevance filter — verifies search results actually match what the user searched for
function filterByRelevance(videos, originalQuery, translatedQuery) {
  const stopWords = new Set(['the', 'and', 'a', 'of', 'in', 'to', 'for', 'is', 'with', 'on', 'at', 'by', 'an', 'it', 'or', 'as', 'be', 'this', 'that', 'are', 'was', 'but', 'not', 'you', 'all', 'can', 'her', 'had', 'do', 'my', 'he', 'she', 'we', 'me']);
  
  // Extract search keywords, ignoring stop words and very short words
  const getKeywords = (q) => {
    if (!q) return [];
    return q.toLowerCase()
      .split(/[\s,.\-\/]+/)
      .map(w => w.replace(/[^\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u0400-\u04ff\u0600-\u06ff]/g, '').trim())
      .filter(w => w.length >= 2 && !stopWords.has(w));
  };

  const originalKeywords = getKeywords(originalQuery);
  const translatedKeywords = getKeywords(translatedQuery);
  
  // If we have no usable keywords, don't filter
  if (originalKeywords.length === 0 && translatedKeywords.length === 0) return videos;

  return videos.filter(v => {
    const titleLower = (v.title || '').toLowerCase();
    const transTitleLower = (v.translatedTitle || '').toLowerCase();
    const channelLower = (v.author || '').toLowerCase();
    const descLower = (v.description || '').toLowerCase();
    
    // Check ALL searchable text fields
    const allText = `${titleLower} ${transTitleLower} ${channelLower} ${descLower}`;
    
    // Must match at least one original keyword (the user's actual search term)
    const matchesOriginal = originalKeywords.some(kw => allText.includes(kw));
    
    // OR match at least one translated keyword
    const matchesTranslated = translatedKeywords.some(kw => allText.includes(kw));

    return matchesOriginal || matchesTranslated;
  });
}

// Handle execution of localized search
async function processGlobalSearch(searchQuery, page = 1) {
  // Reset global seen IDs if the search query changed
  if (searchQuery !== lastSearchQuery) {
    globalSeenIds = new Set();
    lastSearchQuery = searchQuery;
  }
  
  // 1. Get configurations
  const store = await new Promise((resolve) => {
    chrome.storage.local.get(['activeLanguages', 'invidiousInstances', 'maxResultsPerLang', 'excludeEnglish'], resolve);
  });
  
  const activeLangs = store.activeLanguages || DEFAULT_LANGUAGES;
  const instances = store.invidiousInstances || DEFAULT_INSTANCES;
  const maxResults = store.maxResultsPerLang || 15;
  const excludeEnglish = store.excludeEnglish || false;
  
  if (activeLangs.length === 0) return [];

  // 2. Perform translations in parallel
  console.log(`[BarrierBreaker] Translating query: "${searchQuery}" for page ${page}`);
  const translationPromises = activeLangs.map(async (lang) => {
    try {
      const translated = await translateText(searchQuery, 'en', lang.code);
      const properNoun = isLikelyProperNoun(searchQuery, translated);
      return { lang, translated, properNoun };
    } catch (e) {
      return { lang, translated: searchQuery, properNoun: true };
    }
  });
  
  const translations = await Promise.all(translationPromises);
  
  // 3. Concurrently fetch search results from rotating Invidious instances
  const fetchPromises = translations.map(async ({ lang, translated, properNoun }, index) => {
    const primaryInstanceIdx = index % instances.length;
    let rawItems = [];
    let usedInstance = '';

    // Build list of queries to try:
    // - ALWAYS search with the original English query (catches proper nouns, brands, games)
    // - If the translation is different AND not a proper noun, also search with the translated query
    const queriesToFetch = [searchQuery]; // Original query always first
    if (!properNoun && translated.toLowerCase() !== searchQuery.toLowerCase()) {
      queriesToFetch.push(translated);
    }
    
    console.log(`[BarrierBreaker] ${lang.name}: Queries = ${JSON.stringify(queriesToFetch)}, ProperNoun=${properNoun}`);
    
    // Try instances with fallback rotation
    let success = false;
    for (let i = 0; i < Math.min(instances.length, 5); i++) {
      const instanceIdx = (primaryInstanceIdx + i) % instances.length;
      const instance = instances[instanceIdx];
      try {
        console.log(`[BarrierBreaker] Fetching page ${page} for ${lang.name} from ${instance}`);
        
        // Fetch all queries concurrently from the same instance
        const results = await Promise.all(queriesToFetch.map(q => 
          fetchInvidiousResults(instance, q, lang.code, page)
            .catch(e => {
              console.warn(`Query "${q}" failed on ${instance}:`, e.message);
              return [];
            })
        ));
        
        // Merge and flatten all query results
        rawItems = results.flat();
        usedInstance = instance;
        success = true;
        break;
      } catch (err) {
        console.warn(`Failed querying ${instance} for ${lang.name}:`, err.message);
      }
    }
    
    if (!success || rawItems.length === 0) {
      console.warn(`[BarrierBreaker] All attempts failed for language ${lang.name}`);
      return [];
    }

    // Format items
    const videos = rawItems
      .filter(item => item.type === 'video' && item.videoId)
      .map(v => ({
        id: v.videoId,
        title: v.title,
        originalTitle: v.title,
        translatedTitle: '', // will be populated via batch translation
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        author: v.author || '',
        authorUrl: v.authorUrl || `https://www.youtube.com/channel/${v.authorId}`,
        lengthText: v.lengthSeconds ? formatDuration(v.lengthSeconds) : '',
        lengthSeconds: v.lengthSeconds || 0,
        viewsText: v.viewCount ? formatViews(v.viewCount) : '',
        views: v.viewCount || 0,
        publishedText: v.publishedText || '',
        publishedSeconds: parsePublishedTextToSeconds(v.publishedText),
        language: lang,
        queryUsed: translated,
        instanceUsed: usedInstance,
        description: v.description || ''
      }));

    // Deduplicate within this language by video ID
    const seenLocalIds = new Set();
    const uniqueVideos = videos.filter(v => {
      if (seenLocalIds.has(v.id)) return false;
      seenLocalIds.add(v.id);
      return true;
    });

    // Batch translate video titles back to English
    if (lang.code !== 'en' && uniqueVideos.length > 0) {
      try {
        // Batch in groups of 25 to avoid URL length limits
        const batchSize = 25;
        for (let batchStart = 0; batchStart < uniqueVideos.length; batchStart += batchSize) {
          const batch = uniqueVideos.slice(batchStart, batchStart + batchSize);
          const textToTranslate = batch.map(v => v.originalTitle).join('\n');
          const translatedText = await translateText(textToTranslate, lang.code, 'en');
          const translatedTitles = translatedText.split('\n').map(t => t.trim());
          
          if (translatedTitles.length === batch.length) {
            batch.forEach((v, idx) => {
              const trans = translatedTitles[idx];
              if (trans && trans.toLowerCase() !== v.originalTitle.toLowerCase()) {
                v.translatedTitle = trans;
              }
            });
          } else {
            // Fallback: individual translations for mismatched batch
            console.warn(`[BarrierBreaker] Batch mismatch for ${lang.name}: got ${translatedTitles.length} vs ${batch.length}`);
            await Promise.all(batch.map(async (v) => {
              try {
                const trans = await translateText(v.originalTitle, lang.code, 'en');
                if (trans && trans.toLowerCase() !== v.originalTitle.toLowerCase()) {
                  v.translatedTitle = trans;
                }
              } catch (e) {
                // Silent fail for individual title
              }
            }));
          }
        }
      } catch (err) {
        console.warn(`Failed batch translating titles for ${lang.name}:`, err);
      }
    }

    // Apply relevance filter to ensure results match the search query
    const relevantVideos = filterByRelevance(uniqueVideos, searchQuery, translated);
    
    console.log(`[BarrierBreaker] ${lang.name}: ${rawItems.length} raw -> ${uniqueVideos.length} unique -> ${relevantVideos.length} relevant`);

    // Return up to maxResults per language
    return relevantVideos.slice(0, maxResults);
  });

  const resultsByLang = await Promise.all(fetchPromises);
  
  // Aggregate and flatten
  let aggregatedResults = resultsByLang.flat();
  
  // Exclude English videos if configured  
  if (excludeEnglish) {
    aggregatedResults = aggregatedResults.filter(v => {
      // Check if the video title is predominantly English text
      if (isLikelyEnglish(v.originalTitle)) {
        return false;
      }
      return true;
    });
  }
  
  // Deduplicate by video ID (across languages AND across pages)
  const deduplicated = aggregatedResults.filter(v => {
    if (globalSeenIds.has(v.id)) return false;
    globalSeenIds.add(v.id);
    return true;
  });

  console.log(`[BarrierBreaker] Final: ${aggregatedResults.length} aggregated -> ${deduplicated.length} after dedup (global seen: ${globalSeenIds.size})`);

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
      
      // If page is 1, reset global dedup set for fresh search
      if (page === 1) {
        globalSeenIds = new Set();
        lastSearchQuery = message.query;
      }
      
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
  
  if (message.type === 'RESET_DEDUP') {
    globalSeenIds = new Set();
    lastSearchQuery = '';
    sendResponse({ success: true });
    return true;
  }
});
