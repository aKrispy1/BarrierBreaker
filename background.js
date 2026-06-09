// Default settings
const DEFAULT_LANGUAGES = [
  { code: 'ja', name: 'Japanese', accent: '#ff6b8b', region: 'JP' },
  { code: 'es', name: 'Spanish', accent: '#ffd166', region: 'ES' },
  { code: 'ru', name: 'Russian', accent: '#06d6a0', region: 'RU' },
  { code: 'ar', name: 'Arabic', accent: '#118ab2', region: 'SA' },
  { code: 'fr', name: 'French', accent: '#8338ec', region: 'FR' }
];

// Language code → region code mapping for all supported languages
const LANG_TO_REGION = {
  'ja': 'JP', 'es': 'ES', 'ru': 'RU', 'ar': 'SA', 'fr': 'FR',
  'de': 'DE', 'zh': 'TW', 'hi': 'IN', 'ko': 'KR', 'pt': 'BR',
  'it': 'IT', 'tr': 'TR', 'pl': 'PL', 'nl': 'NL', 'vi': 'VN',
  'th': 'TH', 'id': 'ID', 'uk': 'UA', 'sv': 'SE', 'cs': 'CZ'
};

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
            "inv.thepixora.com",
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

// Translation Helper — concatenates all segments for proper full-text translation
async function translateText(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data[0]) {
      return data[0]
        .filter(seg => seg && seg[0])
        .map(seg => seg[0])
        .join('');
    }
    throw new Error('Invalid structure');
  } catch (err) {
    console.error(`Translation error (${from} -> ${to}):`, err);
    return text;
  }
}

// Detect language of a title by checking its script/character composition
function detectTitleLanguage(title) {
  if (!title || title.length === 0) return 'unknown';
  
  // Remove common neutral characters: digits, punctuation, symbols, spaces
  const letters = title.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length === 0) return 'unknown';
  
  const latinChars = (letters.match(/[a-zA-ZÀ-ÿĀ-žŒœ]/g) || []).length;
  const cyrillicChars = (letters.match(/[\u0400-\u04ff]/g) || []).length;
  const arabicChars = (letters.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/g) || []).length;
  const cjkChars = (letters.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/g) || []).length;
  const devanagariChars = (letters.match(/[\u0900-\u097f]/g) || []).length;
  const total = letters.length;
  
  if (cjkChars / total > 0.3) return 'cjk'; // Japanese/Chinese/Korean
  if (cyrillicChars / total > 0.3) return 'cyrillic'; // Russian
  if (arabicChars / total > 0.3) return 'arabic';
  if (devanagariChars / total > 0.3) return 'devanagari'; // Hindi
  if (latinChars / total > 0.7) return 'latin'; // English/French/Spanish/German etc.
  
  return 'mixed';
}

// Check if a title is likely in the target language vs English
// For non-Latin script languages (Japanese, Russian, Arabic, Hindi) this is easy — check script
// For Latin script languages (French, Spanish, German) we check for language-specific patterns
function isTitleInTargetLanguage(title, langCode) {
  const script = detectTitleLanguage(title);
  
  // Non-Latin script languages: if the title uses their script at all, it counts
  if (['ja', 'zh', 'ko'].includes(langCode)) return script === 'cjk' || script === 'mixed';
  if (langCode === 'ru' || langCode === 'uk') return script === 'cyrillic' || script === 'mixed';
  if (langCode === 'ar') return script === 'arabic' || script === 'mixed';
  if (langCode === 'hi') return script === 'devanagari' || script === 'mixed';
  
  // Latin script languages (French, Spanish, German, etc.): 
  // We can't easily distinguish from English by script alone.
  // Accept all Latin-script titles — the relevance filter will handle quality.
  if (['fr', 'es', 'de', 'pt', 'it', 'nl', 'sv', 'pl', 'cs', 'tr', 'vi', 'id'].includes(langCode)) {
    return script === 'latin' || script === 'mixed';
  }
  
  return true; // Default: accept
}

// Check if a title is likely English (for the Exclude English filter)
function isLikelyEnglish(title, translatedTitle, langCode) {
  if (!title) return false;
  
  const script = detectTitleLanguage(title);
  
  // Non-Latin scripts: definitely not English
  if (['cjk', 'cyrillic', 'arabic', 'devanagari'].includes(script)) return false;
  
  // For non-Latin target languages: if title is all Latin text, it's likely English
  if (['ja', 'zh', 'ko', 'ru', 'uk', 'ar', 'hi'].includes(langCode)) {
    if (script === 'latin') return true;
  }
  
  // For Latin-script target languages: check if back-translation didn't change the title
  // If translating FROM the target language TO English produces the same text, it was English
  if (['fr', 'es', 'de', 'pt', 'it', 'nl', 'sv', 'pl', 'cs', 'tr', 'vi', 'id'].includes(langCode)) {
    if (translatedTitle && translatedTitle.toLowerCase().trim() === title.toLowerCase().trim()) {
      return true; // Back-translation identical = was already English
    }
    // If no translated title was generated, the translation was identical = English
    if (!translatedTitle || translatedTitle === '') return true;
  }
  
  return false;
}

// Fetch results from a specific Invidious instance with timeout and REGION parameter
async function fetchInvidiousResults(instance, query, langCode, region, page = 1) {
  // The critical fix: use `region` parameter to get content from the target country
  // The `hl` parameter only changes UI language, `region` changes actual results
  const regionParam = region || LANG_TO_REGION[langCode] || '';
  const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&page=${page}${regionParam ? `&region=${regionParam}` : ''}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  
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

// Keyword relevance filter — verifies results match what the user searched for
function filterByRelevance(videos, originalQuery, translatedQuery) {
  const stopWords = new Set(['the', 'and', 'a', 'of', 'in', 'to', 'for', 'is', 'with', 'on', 'at', 'by', 'an', 'it', 'or', 'as', 'be', 'this', 'that', 'are', 'was', 'but', 'not', 'you', 'all', 'can', 'her', 'had', 'do', 'my', 'he', 'she', 'we', 'me']);
  
  const getKeywords = (q) => {
    if (!q) return [];
    return q.toLowerCase()
      .split(/[\s,.\-\/]+/)
      .map(w => w.replace(/[^\w\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u0400-\u04ff\u0600-\u06ff]/g, '').trim())
      .filter(w => w.length >= 2 && !stopWords.has(w));
  };

  const originalKeywords = getKeywords(originalQuery);
  const translatedKeywords = getKeywords(translatedQuery);
  
  if (originalKeywords.length === 0 && translatedKeywords.length === 0) return videos;

  return videos.filter(v => {
    const titleLower = (v.title || '').toLowerCase();
    const transTitleLower = (v.translatedTitle || '').toLowerCase();
    const channelLower = (v.author || '').toLowerCase();
    const allText = `${titleLower} ${transTitleLower} ${channelLower}`;
    
    const matchesOriginal = originalKeywords.some(kw => allText.includes(kw));
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

  // 2. Translate the search query into each target language
  console.log(`[BarrierBreaker] Translating query: "${searchQuery}" for page ${page}`);
  const translationPromises = activeLangs.map(async (lang) => {
    try {
      const translated = await translateText(searchQuery, 'en', lang.code);
      return { lang, translated };
    } catch (e) {
      return { lang, translated: searchQuery };
    }
  });
  
  const translations = await Promise.all(translationPromises);
  
  // 3. Fetch results for each language using REGION parameter + translated query
  const fetchPromises = translations.map(async ({ lang, translated }, index) => {
    const region = lang.region || LANG_TO_REGION[lang.code] || '';
    const primaryInstanceIdx = index % instances.length;
    let allRawItems = [];
    let usedInstance = '';

    // Build query list:
    // 1. Always search with TRANSLATED query + region (gets native language results)
    // 2. Also search ORIGINAL query + region (catches proper nouns like "Valorant" used globally)
    const queriesToFetch = [];
    
    // Translated query first (this is the main discovery mechanism)
    queriesToFetch.push(translated);
    
    // Also search original if it's different from translation
    if (translated.toLowerCase() !== searchQuery.toLowerCase()) {
      queriesToFetch.push(searchQuery);
    }
    
    console.log(`[BarrierBreaker] ${lang.name} (region=${region}): Queries = ${JSON.stringify(queriesToFetch)}`);
    
    // Try instances with fallback rotation
    let success = false;
    for (let i = 0; i < Math.min(instances.length, 5); i++) {
      const instanceIdx = (primaryInstanceIdx + i) % instances.length;
      const instance = instances[instanceIdx];
      try {
        console.log(`[BarrierBreaker] Fetching page ${page} for ${lang.name} from ${instance} (region=${region})`);
        
        // Fetch all queries concurrently from the same instance, WITH REGION
        const results = await Promise.all(queriesToFetch.map(q => 
          fetchInvidiousResults(instance, q, lang.code, region, page)
            .catch(e => {
              console.warn(`Query "${q}" failed on ${instance}:`, e.message);
              return [];
            })
        ));
        
        allRawItems = results.flat();
        usedInstance = instance;
        success = true;
        break;
      } catch (err) {
        console.warn(`Failed querying ${instance} for ${lang.name}:`, err.message);
      }
    }
    
    if (!success || allRawItems.length === 0) {
      console.warn(`[BarrierBreaker] All attempts failed for language ${lang.name}`);
      return [];
    }

    // Format items
    const videos = allRawItems
      .filter(item => item.type === 'video' && item.videoId)
      .map(v => ({
        id: v.videoId,
        title: v.title || '',
        originalTitle: v.title || '',
        translatedTitle: '',
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

    // Batch translate video titles back to English (for display)
    if (lang.code !== 'en' && uniqueVideos.length > 0) {
      try {
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
            console.warn(`[BarrierBreaker] Batch mismatch for ${lang.name}: got ${translatedTitles.length} vs ${batch.length}`);
            await Promise.all(batch.map(async (v) => {
              try {
                const trans = await translateText(v.originalTitle, lang.code, 'en');
                if (trans && trans.toLowerCase() !== v.originalTitle.toLowerCase()) {
                  v.translatedTitle = trans;
                }
              } catch (e) { /* silent */ }
            }));
          }
        }
      } catch (err) {
        console.warn(`Failed batch translating titles for ${lang.name}:`, err);
      }
    }

    // Apply relevance filter
    const relevantVideos = filterByRelevance(uniqueVideos, searchQuery, translated);
    
    console.log(`[BarrierBreaker] ${lang.name}: ${allRawItems.length} raw -> ${uniqueVideos.length} unique -> ${relevantVideos.length} relevant`);

    return relevantVideos.slice(0, maxResults);
  });

  const resultsByLang = await Promise.all(fetchPromises);
  
  // Aggregate and flatten
  let aggregatedResults = resultsByLang.flat();
  
  // Exclude English videos if configured  
  if (excludeEnglish) {
    const beforeCount = aggregatedResults.length;
    aggregatedResults = aggregatedResults.filter(v => {
      return !isLikelyEnglish(v.originalTitle, v.translatedTitle, v.language.code);
    });
    console.log(`[BarrierBreaker] Exclude English: ${beforeCount} -> ${aggregatedResults.length} (removed ${beforeCount - aggregatedResults.length})`);
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

// Format duration helper
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
    return true;
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
