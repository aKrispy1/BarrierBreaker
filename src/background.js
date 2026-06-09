// ============================================================
// BARRIERBREAKER v4 — Direct YouTube Localization
// ============================================================
// Primary: YouTube HTML Scraping (gl/hl localization)
// Language ID: franc-min trigram classifier
// Pipeline: Fetch HTML → Parse ytInitialData → ML lang filter → UI
// ============================================================

import { franc, francAll } from 'franc-min';

// --- CONFIGURATION ---

const DEFAULT_LANGUAGES = [
  { code: 'ja', name: 'Japanese', accent: '#ff6b8b', region: 'JP', iso3: 'jpn', scripts: ['cjk'] },
  { code: 'es', name: 'Spanish', accent: '#ffd166', region: 'ES', iso3: 'spa', scripts: ['latin'] },
  { code: 'ru', name: 'Russian', accent: '#06d6a0', region: 'RU', iso3: 'rus', scripts: ['cyrillic'] },
  { code: 'ar', name: 'Arabic', accent: '#118ab2', region: 'SA', iso3: 'ara', scripts: ['arabic'] },
  { code: 'fr', name: 'French', accent: '#8338ec', region: 'FR', iso3: 'fra', scripts: ['latin'] }
];

// ISO 639-1 → ISO 639-3 mapping (franc uses ISO 639-3)
const ISO2_TO_ISO3 = {
  'ja': 'jpn', 'es': 'spa', 'ru': 'rus', 'ar': 'ara', 'fr': 'fra',
  'de': 'deu', 'zh': 'cmn', 'hi': 'hin', 'ko': 'kor', 'pt': 'por',
  'it': 'ita', 'tr': 'tur', 'pl': 'pol', 'nl': 'nld', 'vi': 'vie',
  'th': 'tha', 'id': 'ind', 'uk': 'ukr', 'sv': 'swe', 'cs': 'ces',
  'en': 'eng'
};

const LANG_TO_REGION = {
  'ja': 'JP', 'es': 'ES', 'ru': 'RU', 'ar': 'SA', 'fr': 'FR',
  'de': 'DE', 'zh': 'TW', 'hi': 'IN', 'ko': 'KR', 'pt': 'BR',
  'it': 'IT', 'tr': 'TR', 'pl': 'PL', 'nl': 'NL', 'vi': 'VN',
  'th': 'TH', 'id': 'ID', 'uk': 'UA', 'sv': 'SE', 'cs': 'CZ'
};

const LANG_SCRIPTS = {
  'ja': 'cjk', 'zh': 'cjk', 'ko': 'cjk',
  'ru': 'cyrillic', 'uk': 'cyrillic',
  'ar': 'arabic', 'hi': 'devanagari', 'th': 'thai',
  'es': 'latin', 'fr': 'latin', 'de': 'latin', 'pt': 'latin',
  'it': 'latin', 'nl': 'latin', 'sv': 'latin', 'pl': 'latin',
  'tr': 'latin', 'vi': 'latin', 'id': 'latin', 'cs': 'latin',
  'en': 'latin'
};

// Known entities that should NEVER be translated
const KNOWN_ENTITIES = new Set([
  'valorant', 'minecraft', 'fortnite', 'roblox', 'genshin', 'overwatch',
  'apex', 'csgo', 'cs2', 'dota', 'pubg', 'warzone', 'cod', 'fifa',
  'pokemon', 'zelda', 'mario', 'sonic', 'halo', 'destiny', 'diablo',
  'cyberpunk', 'elden ring', 'hogwarts', 'starfield', 'baldur',
  'league of legends', 'world of warcraft', 'final fantasy',
  'gta', 'red dead', 'assassin creed', 'call of duty',
  'netflix', 'spotify', 'tiktok', 'instagram', 'youtube', 'twitch',
  'tesla', 'apple', 'samsung', 'nvidia', 'amd', 'intel',
  'iphone', 'android', 'playstation', 'xbox', 'nintendo', 'steam',
  'anime', 'manga', 'naruto', 'one piece', 'dragon ball', 'jujutsu',
  'attack on titan', 'demon slayer', 'my hero academia',
  'taylor swift', 'drake', 'beyonce', 'bts', 'blackpink', 'twice',
  'marvel', 'avengers', 'batman', 'superman', 'star wars',
  'chatgpt', 'openai', 'google', 'microsoft', 'amazon'
]);

let globalSeenIds = new Set();
let lastSearchQuery = '';
// Search state cache: cacheKey -> { page: number, apiKey: string, token: string }
const activeSearches = {};

// --- HEADER BYPASS (for Google Translate only) ---
async function setupHeaderRules() {
  try {
    const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    const oldRuleIds = oldRules.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldRuleIds,
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "remove" },
            { header: "referer", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "*",
          domains: ["translate.googleapis.com"],
          resourceTypes: ["xmlhttprequest"]
        }
      }]
    });
    console.log("[BB] Header bypass rules registered.");
  } catch (err) {
    console.warn("[BB] Failed registering rules:", err);
  }
}

// --- INIT ---
chrome.runtime.onInstalled.addListener(() => {
  setupHeaderRules();
  chrome.storage.local.get(['activeLanguages', 'bubblesBurst', 'isEnabled', 'maxResultsPerLang'], (res) => {
    const updates = {};
    if (!res.activeLanguages) updates.activeLanguages = DEFAULT_LANGUAGES;
    if (res.bubblesBurst === undefined) updates.bubblesBurst = 0;
    if (res.isEnabled === undefined) updates.isEnabled = true;
    if (!res.maxResultsPerLang) updates.maxResultsPerLang = 15;
    if (Object.keys(updates).length > 0) chrome.storage.local.set(updates);
  });
});

chrome.runtime.onStartup.addListener(() => setupHeaderRules());

// ============================================================
// MODULE 1: QUERY CLASSIFIER
// ============================================================

function classifyQuery(query) {
  const q = query.trim();
  const lower = q.toLowerCase();
  const words = lower.split(/\s+/).filter(w => w.length > 0);

  if (KNOWN_ENTITIES.has(lower)) return { translate: false, query: q, reason: 'known_entity' };
  for (const entity of KNOWN_ENTITIES) {
    if (entity.includes(' ') && lower.includes(entity)) {
      return { translate: false, query: q, reason: 'entity_phrase' };
    }
  }

  if (words.length === 1) return { translate: false, query: q, reason: 'single_word' };

  const commonWords = new Set([
    'how', 'what', 'why', 'when', 'where', 'who', 'which', 'best', 'top',
    'good', 'bad', 'new', 'old', 'big', 'small', 'fast', 'slow', 'easy',
    'hard', 'free', 'make', 'get', 'use', 'play', 'learn', 'watch', 'find',
    'cook', 'build', 'fix', 'clean', 'draw', 'sing', 'dance', 'travel',
    'food', 'music', 'game', 'movie', 'book', 'art', 'sport', 'news',
    'the', 'a', 'an', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'or'
  ]);
  if (words.length === 2 && !words.every(w => commonWords.has(w))) {
    return { translate: false, query: q, reason: 'short_mixed' };
  }

  return { translate: true, query: q, reason: 'natural_language' };
}

// ============================================================
// MODULE 2: LANGUAGE DETECTION (franc + script analysis)
// ============================================================

function detectScript(text) {
  if (!text) return 'unknown';
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length === 0) return 'unknown';

  const counts = {
    latin: (letters.match(/[a-zA-ZÀ-ÿĀ-žŒœ]/g) || []).length,
    cjk: (letters.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7af]/g) || []).length,
    cyrillic: (letters.match(/[\u0400-\u04ff]/g) || []).length,
    arabic: (letters.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g) || []).length,
    devanagari: (letters.match(/[\u0900-\u097f]/g) || []).length,
    thai: (letters.match(/[\u0e00-\u0e7f]/g) || []).length
  };

  let maxScript = 'unknown';
  let maxCount = 0;
  for (const [script, count] of Object.entries(counts)) {
    if (count > maxCount) { maxCount = count; maxScript = script; }
  }
  return maxScript;
}

function classifyVideoLanguage(title, description, targetLangCode) {
  const targetIso3 = ISO2_TO_ISO3[targetLangCode] || targetLangCode;
  const targetScript = LANG_SCRIPTS[targetLangCode] || 'latin';
  const combinedText = `${title} ${description || ''}`.trim();

  if (targetScript !== 'latin') {
    const script = detectScript(title);
    if (script === targetScript) {
      return { match: true, confidence: 0.9, detectedLang: targetLangCode, source: 'script' };
    }
    if (script === 'latin') {
      return { match: false, confidence: 0.85, detectedLang: 'en', source: 'script_mismatch' };
    }
    if (script !== 'unknown') {
      return { match: false, confidence: 0.6, detectedLang: 'other', source: 'script_other' };
    }
  }

  if (combinedText.length >= 10) {
    const allLangs = francAll(combinedText);

    if (allLangs.length > 0 && allLangs[0][0] !== 'und') {
      const topLang = allLangs[0][0]; // ISO 639-3
      const topScore = allLangs[0][1];

      const targetEntry = allLangs.find(([code]) => code === targetIso3);
      const targetScore = targetEntry ? targetEntry[1] : 0;

      const engEntry = allLangs.find(([code]) => code === 'eng');
      const engScore = engEntry ? engEntry[1] : 0;

      if (topLang === targetIso3) {
        return { match: true, confidence: topScore, detectedLang: targetLangCode, source: 'franc_top' };
      }

      if (targetScore > 0.3 && targetScore > engScore) {
        return { match: true, confidence: targetScore, detectedLang: targetLangCode, source: 'franc_above_en' };
      }

      if (topLang === 'eng' && engScore > 0.5) {
        return { match: false, confidence: engScore, detectedLang: 'en', source: 'franc_english' };
      }

      if (targetScript === 'latin' && engScore < 0.4) {
        return { match: true, confidence: 0.4, detectedLang: targetLangCode, source: 'franc_non_english' };
      }

      return { match: false, confidence: topScore, detectedLang: topLang, source: 'franc_other' };
    }
  }

  const script = detectScript(combinedText);
  if (targetScript === 'latin' && script === 'latin') {
    return { match: true, confidence: 0.35, detectedLang: 'unknown', source: 'short_text_latin' };
  }

  return { match: true, confidence: 0.2, detectedLang: 'unknown', source: 'fallback' };
}

function isLikelyEnglish(title, description) {
  const text = `${title} ${description || ''}`.trim();
  if (text.length < 5) return false;

  const script = detectScript(title);
  if (script !== 'latin' && script !== 'unknown') return false;

  if (text.length >= 10) {
    const detected = franc(text);
    return detected === 'eng';
  }

  return false;
}

// ============================================================
// MODULE 3: DIRECT SEARCH & SCRAPING BACKEND
// ============================================================

function extractYtInitialData(html) {
  const marker = 'var ytInitialData = ';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) {
    const altMarker = 'window["ytInitialData"] = ';
    const altStartIdx = html.indexOf(altMarker);
    if (altStartIdx === -1) return null;
    
    const remaining = html.substring(altStartIdx + altMarker.length);
    const endIdx = remaining.indexOf(';</script>');
    if (endIdx === -1) return null;
    return JSON.parse(remaining.substring(0, endIdx));
  }
  
  const remaining = html.substring(startIdx + marker.length);
  const endIdx = remaining.indexOf(';</script>');
  if (endIdx === -1) {
    const semiIdx = remaining.indexOf(';');
    if (semiIdx === -1) return null;
    return JSON.parse(remaining.substring(0, semiIdx));
  }
  return JSON.parse(remaining.substring(0, endIdx));
}

function parseVideoRenderer(vr) {
  const videoId = vr.videoId;
  const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || '';
  const description = vr.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') || vr.descriptionSnippet?.runs?.map(r => r.text).join('') || '';
  const author = vr.ownerText?.runs?.map(r => r.text).join('') || '';
  const authorUrl = vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || 
                    vr.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
  const viewCountText = vr.viewCountText?.simpleText || vr.viewCountText?.runs?.map(r => r.text).join('') || '';
  const publishedText = vr.publishedTimeText?.simpleText || '';
  const durationText = vr.lengthText?.simpleText || '';

  // Parse view count
  let views = 0;
  const viewMatch = viewCountText.replace(/[,.\s]/g, '').match(/(\d+)/);
  if (viewMatch) views = parseInt(viewMatch[1], 10);

  // Parse duration to seconds
  let lengthSeconds = 0;
  if (durationText) {
    const parts = durationText.split(':').map(Number);
    if (parts.length === 3) lengthSeconds = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
    else if (parts.length === 2) lengthSeconds = parts[0] * 60 + (parts[1] || 0);
  }

  return {
    id: videoId,
    title,
    originalTitle: title,
    translatedTitle: '',
    description,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    author,
    authorUrl: (authorUrl && authorUrl.startsWith('http')) ? authorUrl : (authorUrl ? `https://www.youtube.com${authorUrl}` : ''),
    lengthText: durationText,
    lengthSeconds,
    viewsText: viewCountText,
    views,
    publishedText,
    publishedSeconds: parsePublishedTextToSeconds(publishedText),
    source: 'youtube'
  };
}

async function fetchSearchPage(query, langCode, region) {
  const gl = region || LANG_TO_REGION[langCode] || 'US';
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&gl=${gl}&hl=${langCode}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept-Language': `${langCode},en-US;q=0.9,en;q=0.8`
    }
  });
  if (!response.ok) throw new Error(`YouTube results page fetch failed: ${response.status}`);
  const html = await response.text();
  return { html, gl };
}

async function fetchContinuation(apiKey, token, langCode, region) {
  const postUrl = `https://www.youtube.com/youtubei/v1/search?key=${apiKey}&prettyPrint=false`;
  const payload = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20260308.00.00',
        gl: region,
        hl: langCode,
        utcOffsetMinutes: 0
      }
    },
    continuation: token
  };
  const response = await fetch(postUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`YouTube continuation POST failed: ${response.status}`);
  return await response.json();
}

async function searchYouTube(query, langCode, region, page = 1) {
  const gl = region || LANG_TO_REGION[langCode] || 'US';
  const cacheKey = `${query}_${langCode}_${gl}`;
  const videos = [];
  let nextToken = null;

  try {
    if (page === 1) {
      console.log(`[BB] Querying native page 1 search for "${query}" (lang: ${langCode}, gl: ${gl})`);
      const { html } = await fetchSearchPage(query, langCode, gl);
      const data = extractYtInitialData(html);
      if (!data) throw new Error('Could not parse ytInitialData from YouTube HTML');

      const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      const apiKey = keyMatch ? keyMatch[1] : null;

      // Extract initial videos
      const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
      if (contents) {
        for (const section of contents) {
          const itemSection = section.itemSectionRenderer;
          if (!itemSection || !itemSection.contents) continue;
          for (const item of itemSection.contents) {
            if (item.videoRenderer) {
              videos.push(parseVideoRenderer(item.videoRenderer));
            }
          }
        }
        
        // Find continuation token
        const lastItem = contents[contents.length - 1];
        if (lastItem && lastItem.continuationItemRenderer) {
          nextToken = lastItem.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
        }
      }

      activeSearches[cacheKey] = { page: 1, apiKey, token: nextToken };
    } else {
      const cached = activeSearches[cacheKey];
      if (cached && cached.page === page - 1 && cached.token && cached.apiKey) {
        console.log(`[BB] Querying native continuation page ${page} for "${query}"`);
        const responseJson = await fetchContinuation(cached.apiKey, cached.token, langCode, gl);
        
        const items = responseJson.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems ||
                      responseJson.continuationContents?.searchContinuation?.contents;
        
        if (items) {
          for (const item of items) {
            if (item.itemSectionRenderer && item.itemSectionRenderer.contents) {
              for (const subItem of item.itemSectionRenderer.contents) {
                if (subItem.videoRenderer) {
                  videos.push(parseVideoRenderer(subItem.videoRenderer));
                }
              }
            } else if (item.videoRenderer) {
              videos.push(parseVideoRenderer(item.videoRenderer));
            } else if (item.continuationItemRenderer) {
              nextToken = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
            }
          }
        }
        activeSearches[cacheKey] = { page, apiKey: cached.apiKey, token: nextToken };
      } else {
        // Cache miss/restart: reconstruct continuation chain
        console.log(`[BB] Cache miss or restart. Reconstructing continuation chain for ${langCode}/${gl} to page ${page}`);
        const { html } = await fetchSearchPage(query, langCode, gl);
        const data = extractYtInitialData(html);
        if (!data) throw new Error('Could not parse ytInitialData from YouTube HTML');
        const keyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        const apiKey = keyMatch ? keyMatch[1] : null;
        
        const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        let token = null;
        if (contents) {
          const lastItem = contents[contents.length - 1];
          if (lastItem && lastItem.continuationItemRenderer) {
            token = lastItem.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
          }
        }

        let currentPageVideos = [];
        let currentToken = token;
        
        // Loop to traverse continuation tokens sequentially
        for (let p = 2; p <= page; p++) {
          if (!currentToken || !apiKey) break;
          const responseJson = await fetchContinuation(apiKey, currentToken, langCode, gl);
          currentPageVideos = [];
          currentToken = null;
          
          const items = responseJson.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems ||
                        responseJson.continuationContents?.searchContinuation?.contents;
          if (items) {
            for (const item of items) {
              if (item.itemSectionRenderer && item.itemSectionRenderer.contents) {
                for (const subItem of item.itemSectionRenderer.contents) {
                  if (subItem.videoRenderer) {
                    currentPageVideos.push(parseVideoRenderer(subItem.videoRenderer));
                  }
                }
              } else if (item.videoRenderer) {
                currentPageVideos.push(parseVideoRenderer(item.videoRenderer));
              } else if (item.continuationItemRenderer) {
                currentToken = item.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
              }
            }
          }
        }
        
        videos.push(...currentPageVideos);
        activeSearches[cacheKey] = { page, apiKey, token: currentToken };
      }
    }
  } catch (err) {
    console.error(`[BB] YouTube scrape search failed for ${langCode}/${gl} page ${page}:`, err);
    throw err;
  }

  console.log(`[BB] YouTube results: got ${videos.length} raw videos for ${langCode}/${gl}`);
  return videos;
}

// ============================================================
// MODULE 4: TRANSLATION (for natural language queries)
// ============================================================

async function translateText(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data[0]) {
      return data[0].filter(seg => seg && seg[0]).map(seg => seg[0]).join('');
    }
    return text;
  } catch (err) {
    console.warn(`[BB] Translation failed (${from}->${to}):`, err);
    return text;
  }
}

async function batchTranslateTitles(videos, fromLang) {
  if (videos.length === 0) return;
  try {
    const batchSize = 20;
    for (let i = 0; i < videos.length; i += batchSize) {
      const batch = videos.slice(i, i + batchSize);
      const text = batch.map(v => v.originalTitle).join('\n');
      const translated = await translateText(text, fromLang, 'en');
      const lines = translated.split('\n').map(t => t.trim());
      if (lines.length === batch.length) {
        batch.forEach((v, idx) => {
          if (lines[idx] && lines[idx].toLowerCase() !== v.originalTitle.toLowerCase()) {
            v.translatedTitle = lines[idx];
          }
        });
      }
    }
  } catch (err) {
    console.warn(`[BB] Batch translate failed:`, err);
  }
}

// ============================================================
// MODULE 5: MAIN SEARCH ORCHESTRATOR
// ============================================================

async function processGlobalSearch(searchQuery, page = 1) {
  if (searchQuery !== lastSearchQuery) {
    globalSeenIds = new Set();
    lastSearchQuery = searchQuery;
    for (const key in activeSearches) {
      delete activeSearches[key];
    }
  }

  const store = await new Promise(resolve => {
    chrome.storage.local.get(['activeLanguages', 'maxResultsPerLang', 'excludeEnglish'], resolve);
  });

  const activeLangs = store.activeLanguages || DEFAULT_LANGUAGES;
  const maxResults = store.maxResultsPerLang || 15;
  const excludeEnglish = store.excludeEnglish || false;

  if (activeLangs.length === 0) return [];

  // Step 1: Classify query
  const queryInfo = classifyQuery(searchQuery);
  console.log(`[BB] Query: "${searchQuery}" → ${queryInfo.reason} (translate: ${queryInfo.translate})`);

  // Step 2: Translate if needed
  let translatedQueries = {};
  if (queryInfo.translate) {
    const translations = await Promise.all(activeLangs.map(async (lang) => {
      const translated = await translateText(searchQuery, 'en', lang.code);
      return { code: lang.code, translated };
    }));
    translations.forEach(t => { translatedQueries[t.code] = t.translated; });
    console.log(`[BB] Translations:`, translatedQueries);
  }

  // Step 3: Search each language
  const fetchPromises = activeLangs.map(async (lang) => {
    const region = lang.region || LANG_TO_REGION[lang.code] || 'US';
    const searchQ = queryInfo.translate ? (translatedQueries[lang.code] || searchQuery) : searchQuery;

    let rawVideos = [];

    try {
      rawVideos = await searchYouTube(searchQ, lang.code, region, page);

      // Also search original query if translation was used (catches proper nouns in translated queries)
      if (queryInfo.translate && searchQ.toLowerCase() !== searchQuery.toLowerCase()) {
        try {
          const origVideos = await searchYouTube(searchQuery, lang.code, region, page);
          rawVideos = [...rawVideos, ...origVideos];
        } catch (e) { /* supplementary failed, continue */ }
      }
    } catch (err) {
      console.error(`[BB] YouTube search failed for ${lang.name}:`, err.message);
      return [];
    }

    if (rawVideos.length === 0) return [];

    // Dedup within language
    const seenLocal = new Set();
    const uniqueVideos = rawVideos.filter(v => {
      if (seenLocal.has(v.id)) return false;
      seenLocal.add(v.id);
      return true;
    });

    // Tag with language metadata
    uniqueVideos.forEach(v => { v.language = lang; v.queryUsed = searchQ; });

    // Batch translate titles
    if (lang.code !== 'en') {
      await batchTranslateTitles(uniqueVideos, lang.code);
    }

    // Step 4: LANGUAGE DETECTION
    const langFiltered = [];
    for (const v of uniqueVideos) {
      const classification = classifyVideoLanguage(v.title, v.description, lang.code);
      v.langConfidence = classification.confidence;
      v.langSource = classification.source;
      v.detectedLang = classification.detectedLang;

      if (classification.match) {
        langFiltered.push(v);
      }
    }

    console.log(`[BB] ${lang.name}: ${rawVideos.length} raw → ${uniqueVideos.length} unique → ${langFiltered.length} lang-verified`);
    return langFiltered.slice(0, maxResults);
  });

  const resultsByLang = await Promise.all(fetchPromises);
  let aggregated = resultsByLang.flat();

  // Step 5: Exclude English if configured
  if (excludeEnglish) {
    const before = aggregated.length;
    aggregated = aggregated.filter(v => !isLikelyEnglish(v.title, v.description));
    console.log(`[BB] Exclude English: ${before} → ${aggregated.length}`);
  }

  // Step 6: Global dedup
  const deduplicated = aggregated.filter(v => {
    if (globalSeenIds.has(v.id)) return false;
    globalSeenIds.add(v.id);
    return true;
  });

  console.log(`[BB] Final: ${aggregated.length} → ${deduplicated.length} (global seen: ${globalSeenIds.size})`);
  return deduplicated;
}

// ============================================================
// UTILITIES
// ============================================================

function parsePublishedTextToSeconds(text) {
  if (!text) return 9999999999;
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
  if (!match) return 9999999999;
  const val = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const m = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  for (const [k, mult] of Object.entries(m)) { if (unit.startsWith(k)) return val * mult; }
  return val;
}

// ============================================================
// MESSAGE LISTENER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_GLOBAL_RESULTS') {
    chrome.storage.local.get('isEnabled', (store) => {
      if (store.isEnabled === false) {
        sendResponse({ success: true, videos: [], disabled: true });
        return;
      }
      const page = message.page || 1;
      if (page === 1) {
        globalSeenIds = new Set();
        lastSearchQuery = message.query;
      }
      processGlobalSearch(message.query, page)
        .then(videos => sendResponse({ success: true, videos }))
        .catch(err => {
          console.error('[BB] Search failed:', err);
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
});
