// ============================================================
// BARRIERBREAKER v2 — InnerTube-First Architecture
// ============================================================
// Primary: YouTube InnerTube API (gl/hl for real localization)
// Fallback: Invidious instances (best-effort)
// Post-filter: Script-based language detection pipeline
// ============================================================

// --- CONFIGURATION ---

const DEFAULT_LANGUAGES = [
  { code: 'ja', name: 'Japanese', accent: '#ff6b8b', region: 'JP', scripts: ['cjk'] },
  { code: 'es', name: 'Spanish', accent: '#ffd166', region: 'ES', scripts: ['latin'] },
  { code: 'ru', name: 'Russian', accent: '#06d6a0', region: 'RU', scripts: ['cyrillic'] },
  { code: 'ar', name: 'Arabic', accent: '#118ab2', region: 'SA', scripts: ['arabic'] },
  { code: 'fr', name: 'French', accent: '#8338ec', region: 'FR', scripts: ['latin'] }
];

const LANG_TO_REGION = {
  'ja': 'JP', 'es': 'ES', 'ru': 'RU', 'ar': 'SA', 'fr': 'FR',
  'de': 'DE', 'zh': 'TW', 'hi': 'IN', 'ko': 'KR', 'pt': 'BR',
  'it': 'IT', 'tr': 'TR', 'pl': 'PL', 'nl': 'NL', 'vi': 'VN',
  'th': 'TH', 'id': 'ID', 'uk': 'UA', 'sv': 'SE', 'cs': 'CZ'
};

const LANG_SCRIPTS = {
  'ja': ['cjk'], 'zh': ['cjk'], 'ko': ['cjk'],
  'ru': ['cyrillic'], 'uk': ['cyrillic'],
  'ar': ['arabic'],
  'hi': ['devanagari'],
  'th': ['thai'],
  'es': ['latin'], 'fr': ['latin'], 'de': ['latin'], 'pt': ['latin'],
  'it': ['latin'], 'nl': ['latin'], 'sv': ['latin'], 'pl': ['latin'],
  'tr': ['latin'], 'vi': ['latin'], 'id': ['latin'], 'cs': ['latin']
};

// Known proper nouns / brands / games that should NEVER be translated
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

const DEFAULT_INSTANCES = [
  'https://inv.thepixora.com',
  'https://yewtu.be',
  'https://invidious.projectsegfau.lt',
  'https://invidious.flokinet.to',
  'https://invidious.privacydev.net',
  'https://invidious.lunar.icu',
  'https://invidious.fdn.fr'
];

const INNERTUBE_CLIENT_VERSION = '2.20250601.00.00';
const RULE_ID = 1;

// Global state
let globalSeenIds = new Set();
let lastSearchQuery = '';
let innerTubeContinuations = {}; // lang -> continuation token

// --- HEADER BYPASS RULES ---

async function setupHeaderRules() {
  try {
    const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    const oldRuleIds = oldRules.map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldRuleIds,
      addRules: [{
        id: RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "remove" },
            { header: "referer", operation: "remove" },
            { header: "user-agent", operation: "set", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" }
          ]
        },
        condition: {
          urlFilter: "*",
          domains: [
            "translate.googleapis.com",
            "inv.thepixora.com", "yewtu.be",
            "invidious.projectsegfau.lt", "invidious.flokinet.to",
            "invidious.privacydev.net", "invidious.lunar.icu", "invidious.fdn.fr"
          ],
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
  chrome.storage.local.get(['activeLanguages', 'invidiousInstances', 'bubblesBurst', 'isEnabled', 'maxResultsPerLang'], (res) => {
    const updates = {};
    if (!res.activeLanguages) updates.activeLanguages = DEFAULT_LANGUAGES;
    if (!res.invidiousInstances) updates.invidiousInstances = DEFAULT_INSTANCES;
    if (res.bubblesBurst === undefined) updates.bubblesBurst = 0;
    if (res.isEnabled === undefined) updates.isEnabled = true;
    if (!res.maxResultsPerLang) updates.maxResultsPerLang = 15;
    if (Object.keys(updates).length > 0) chrome.storage.local.set(updates);
  });
});

chrome.runtime.onStartup.addListener(() => setupHeaderRules());

// ============================================================
// MODULE 1: QUERY CLASSIFIER
// Decides whether/how to translate a query
// ============================================================

function classifyQuery(query) {
  const q = query.trim();
  const lower = q.toLowerCase();
  const words = lower.split(/\s+/).filter(w => w.length > 0);

  // Check against known entities list
  if (KNOWN_ENTITIES.has(lower)) {
    return { type: 'entity', translate: false, query: q };
  }

  // Check multi-word known entities
  for (const entity of KNOWN_ENTITIES) {
    if (entity.includes(' ') && lower.includes(entity)) {
      return { type: 'entity_phrase', translate: false, query: q, entity };
    }
  }

  // Single word queries — likely a proper noun or brand, don't translate
  if (words.length === 1) {
    return { type: 'single_word', translate: false, query: q };
  }

  // 2-word queries — translate only if both words are common English
  if (words.length === 2) {
    const commonWords = new Set([
      'how', 'what', 'why', 'when', 'where', 'who', 'which', 'best', 'top',
      'good', 'bad', 'new', 'old', 'big', 'small', 'fast', 'slow', 'easy',
      'hard', 'free', 'make', 'get', 'use', 'play', 'learn', 'watch', 'find',
      'cook', 'build', 'fix', 'clean', 'draw', 'sing', 'dance', 'travel',
      'food', 'music', 'game', 'movie', 'book', 'art', 'sport', 'news',
      'home', 'work', 'life', 'love', 'day', 'night', 'time', 'way',
      'the', 'a', 'an', 'to', 'in', 'on', 'at', 'for', 'with', 'and', 'or'
    ]);
    const allCommon = words.every(w => commonWords.has(w));
    if (allCommon) {
      return { type: 'short_phrase', translate: true, query: q };
    }
    return { type: 'short_mixed', translate: false, query: q };
  }

  // 3+ word queries — likely a natural language question, translate
  return { type: 'long_phrase', translate: true, query: q };
}

// ============================================================
// MODULE 2: LANGUAGE DETECTION PIPELINE
// Classifies the actual language of a video's content
// ============================================================

function detectScript(text) {
  if (!text || text.length === 0) return { script: 'unknown', confidence: 0 };

  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length === 0) return { script: 'unknown', confidence: 0 };

  const counts = {
    latin: (letters.match(/[a-zA-ZÀ-ÿĀ-žŒœŚśŹźŃńŁłĆć]/g) || []).length,
    cjk: (letters.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7af]/g) || []).length,
    cyrillic: (letters.match(/[\u0400-\u04ff\u0500-\u052f]/g) || []).length,
    arabic: (letters.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/g) || []).length,
    devanagari: (letters.match(/[\u0900-\u097f]/g) || []).length,
    thai: (letters.match(/[\u0e00-\u0e7f]/g) || []).length
  };

  const total = letters.length;
  let maxScript = 'unknown';
  let maxRatio = 0;

  for (const [script, count] of Object.entries(counts)) {
    const ratio = count / total;
    if (ratio > maxRatio) {
      maxRatio = ratio;
      maxScript = script;
    }
  }

  return { script: maxScript, confidence: maxRatio };
}

function classifyVideoLanguage(video, targetLangCode) {
  const titleText = video.title || '';
  const descText = (video.description || '').slice(0, 500); // First 500 chars
  const combinedText = `${titleText} ${descText}`;

  // 1. Check YouTube's own language metadata (strongest signal)
  if (video.defaultAudioLanguage) {
    const audioLang = video.defaultAudioLanguage.split('-')[0].toLowerCase();
    if (audioLang === targetLangCode) return { match: true, confidence: 0.95, source: 'audioLang' };
    if (audioLang === 'en') return { match: false, confidence: 0.95, source: 'audioLang_en' };
  }
  if (video.defaultLanguage) {
    const defLang = video.defaultLanguage.split('-')[0].toLowerCase();
    if (defLang === targetLangCode) return { match: true, confidence: 0.85, source: 'defaultLang' };
    if (defLang === 'en') return { match: false, confidence: 0.85, source: 'defaultLang_en' };
  }

  // 2. Script-based detection
  const targetScripts = LANG_SCRIPTS[targetLangCode] || ['latin'];
  const titleDetection = detectScript(titleText);
  const combinedDetection = detectScript(combinedText);

  // For non-Latin target languages: check if title uses the expected script
  if (!targetScripts.includes('latin')) {
    const expectedScript = targetScripts[0];
    if (titleDetection.script === expectedScript && titleDetection.confidence > 0.2) {
      return { match: true, confidence: titleDetection.confidence, source: 'script_title' };
    }
    if (combinedDetection.script === expectedScript && combinedDetection.confidence > 0.2) {
      return { match: true, confidence: combinedDetection.confidence * 0.9, source: 'script_combined' };
    }
    // Title is all Latin → likely English, not target language
    if (titleDetection.script === 'latin' && titleDetection.confidence > 0.8) {
      return { match: false, confidence: 0.8, source: 'script_latin_mismatch' };
    }
  }

  // For Latin-script target languages (fr, es, de, etc.):
  // Can't reliably distinguish from English by script alone
  // Use back-translation comparison if available, otherwise assume match
  if (targetScripts.includes('latin')) {
    if (video.translatedTitle) {
      const titleLower = titleText.toLowerCase().trim();
      const transLower = video.translatedTitle.toLowerCase().trim();
      // If back-translation is identical, it was already English
      if (titleLower === transLower) {
        return { match: false, confidence: 0.7, source: 'backtrans_identical' };
      }
      // If back-translation changed significantly, title was in target language
      return { match: true, confidence: 0.6, source: 'backtrans_different' };
    }
    // No translation data — moderate confidence it's in target language
    // (since we searched with gl=region, YouTube should prioritize local content)
    return { match: true, confidence: 0.4, source: 'latin_default' };
  }

  return { match: true, confidence: 0.3, source: 'fallback' };
}

function isLikelyEnglish(video) {
  if (video.defaultAudioLanguage) {
    const lang = video.defaultAudioLanguage.split('-')[0].toLowerCase();
    if (lang === 'en') return true;
  }
  const titleDetection = detectScript(video.title || '');
  // If title is >85% Latin characters with no other script presence
  if (titleDetection.script === 'latin' && titleDetection.confidence > 0.85) {
    // Check if back-translation didn't change it (means it was already English)
    if (video.translatedTitle) {
      const same = (video.title || '').toLowerCase().trim() === video.translatedTitle.toLowerCase().trim();
      if (same) return true;
    }
    // No translated title and all Latin — likely English
    if (!video.translatedTitle) return true;
  }
  return false;
}

// ============================================================
// MODULE 3: INNERTUBE SEARCH BACKEND (Primary)
// Direct POST to YouTube's internal API
// ============================================================

async function searchInnerTube(query, langCode, region, page = 1) {
  const gl = region || LANG_TO_REGION[langCode] || 'US';
  const hl = langCode || 'en';

  let url = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
  let body;

  // Check if we have a continuation token for pagination
  const contKey = `${langCode}_${region}`;
  if (page > 1 && innerTubeContinuations[contKey]) {
    body = JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: INNERTUBE_CLIENT_VERSION,
          hl: hl,
          gl: gl
        }
      },
      continuation: innerTubeContinuations[contKey]
    });
  } else {
    body = JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: INNERTUBE_CLIENT_VERSION,
          hl: hl,
          gl: gl
        }
      },
      query: query
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
      body: body
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`InnerTube HTTP ${res.status}`);
    const data = await res.json();

    // Parse the response
    return parseInnerTubeResponse(data, langCode, region, contKey);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[BB] InnerTube search failed for ${langCode}/${region}:`, err.message);
    throw err;
  }
}

function parseInnerTubeResponse(data, langCode, region, contKey) {
  const videos = [];

  // Extract video renderers from the nested response
  let contents = [];
  let continuationToken = null;

  // Page 1 response structure
  if (data.contents) {
    const sectionList = data.contents.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer;
    if (sectionList?.contents) {
      for (const section of sectionList.contents) {
        if (section.itemSectionRenderer?.contents) {
          contents.push(...section.itemSectionRenderer.contents);
        }
        // Look for continuation
        if (section.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
          continuationToken = section.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        }
      }
    }
  }

  // Continuation response structure (page 2+)
  if (data.onResponseReceivedCommands) {
    for (const cmd of data.onResponseReceivedCommands) {
      if (cmd.appendContinuationItemsAction?.continuationItems) {
        for (const item of cmd.appendContinuationItemsAction.continuationItems) {
          if (item.itemSectionRenderer?.contents) {
            contents.push(...item.itemSectionRenderer.contents);
          }
          if (item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
            continuationToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
          }
        }
      }
    }
  }

  // Store continuation token for next page
  if (continuationToken) {
    innerTubeContinuations[contKey] = continuationToken;
  } else {
    delete innerTubeContinuations[contKey];
  }

  // Parse video renderers
  for (const item of contents) {
    const vr = item.videoRenderer;
    if (!vr || !vr.videoId) continue;

    const title = vr.title?.runs?.map(r => r.text).join('') || '';
    const description = vr.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') ||
                        vr.descriptionSnippet?.runs?.map(r => r.text).join('') || '';
    const author = vr.ownerText?.runs?.[0]?.text || '';
    const authorUrl = vr.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';

    // Parse view count
    let viewCount = 0;
    const viewText = vr.viewCountText?.simpleText || vr.viewCountText?.runs?.map(r => r.text).join('') || '';
    const viewMatch = viewText.replace(/[,.\s]/g, '').match(/(\d+)/);
    if (viewMatch) viewCount = parseInt(viewMatch[1], 10);

    // Parse duration
    let lengthSeconds = 0;
    const durText = vr.lengthText?.simpleText || '';
    const durParts = durText.split(':').map(Number);
    if (durParts.length === 3) lengthSeconds = durParts[0] * 3600 + durParts[1] * 60 + durParts[2];
    else if (durParts.length === 2) lengthSeconds = durParts[0] * 60 + durParts[1];

    // Published time
    const publishedText = vr.publishedTimeText?.simpleText || '';

    videos.push({
      id: vr.videoId,
      title: title,
      originalTitle: title,
      translatedTitle: '',
      description: description,
      thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/mqdefault.jpg`,
      author: author,
      authorUrl: authorUrl ? `https://www.youtube.com${authorUrl}` : '',
      lengthText: durText,
      lengthSeconds: lengthSeconds,
      viewsText: viewText,
      views: viewCount,
      publishedText: publishedText,
      publishedSeconds: parsePublishedTextToSeconds(publishedText),
      defaultLanguage: vr.defaultLanguage || '',
      defaultAudioLanguage: vr.defaultAudioLanguage || '',
      source: 'innertube'
    });
  }

  console.log(`[BB] InnerTube ${langCode}/${region}: parsed ${videos.length} videos, continuation: ${!!continuationToken}`);
  return videos;
}

// ============================================================
// MODULE 4: INVIDIOUS FALLBACK BACKEND
// ============================================================

async function searchInvidious(query, langCode, region, page, instances) {
  for (let i = 0; i < Math.min(instances.length, 4); i++) {
    const instance = instances[i];
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&page=${page}${region ? `&region=${region}` : ''}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;

      return data.filter(item => item.type === 'video' && item.videoId).map(v => ({
        id: v.videoId,
        title: v.title || '',
        originalTitle: v.title || '',
        translatedTitle: '',
        description: v.description || '',
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        author: v.author || '',
        authorUrl: v.authorUrl || '',
        lengthText: v.lengthSeconds ? formatDuration(v.lengthSeconds) : '',
        lengthSeconds: v.lengthSeconds || 0,
        viewsText: v.viewCount ? formatViews(v.viewCount) : '',
        views: v.viewCount || 0,
        publishedText: v.publishedText || '',
        publishedSeconds: parsePublishedTextToSeconds(v.publishedText),
        defaultLanguage: '',
        defaultAudioLanguage: '',
        source: 'invidious',
        instanceUsed: instance
      }));
    } catch (err) {
      console.warn(`[BB] Invidious ${instance} failed:`, err.message);
    }
  }
  return [];
}

// ============================================================
// MODULE 5: TRANSLATION
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
    throw new Error('Invalid structure');
  } catch (err) {
    console.error(`[BB] Translation error (${from}->${to}):`, err);
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
// MODULE 6: MAIN SEARCH ORCHESTRATOR
// ============================================================

async function processGlobalSearch(searchQuery, page = 1) {
  if (searchQuery !== lastSearchQuery) {
    globalSeenIds = new Set();
    lastSearchQuery = searchQuery;
    innerTubeContinuations = {};
  }

  const store = await new Promise(resolve => {
    chrome.storage.local.get(['activeLanguages', 'invidiousInstances', 'maxResultsPerLang', 'excludeEnglish'], resolve);
  });

  const activeLangs = store.activeLanguages || DEFAULT_LANGUAGES;
  const instances = store.invidiousInstances || DEFAULT_INSTANCES;
  const maxResults = store.maxResultsPerLang || 15;
  const excludeEnglish = store.excludeEnglish || false;

  if (activeLangs.length === 0) return [];

  // Step 1: Classify the query
  const queryInfo = classifyQuery(searchQuery);
  console.log(`[BB] Query classification:`, queryInfo);

  // Step 2: Prepare translated queries if needed
  let translatedQueries = {};
  if (queryInfo.translate) {
    const translationPromises = activeLangs.map(async (lang) => {
      try {
        const translated = await translateText(searchQuery, 'en', lang.code);
        translatedQueries[lang.code] = translated;
      } catch (e) {
        translatedQueries[lang.code] = searchQuery;
      }
    });
    await Promise.all(translationPromises);
    console.log(`[BB] Translated queries:`, translatedQueries);
  }

  // Step 3: Search each language in parallel
  const fetchPromises = activeLangs.map(async (lang) => {
    const region = lang.region || LANG_TO_REGION[lang.code] || 'US';

    // Determine the search query for this language
    const searchQ = queryInfo.translate ? (translatedQueries[lang.code] || searchQuery) : searchQuery;

    let rawVideos = [];
    let backendUsed = 'none';

    // Try InnerTube first (primary)
    try {
      rawVideos = await searchInnerTube(searchQ, lang.code, region, page);
      backendUsed = 'innertube';

      // If translated query was used, also search the original query for proper noun coverage
      if (queryInfo.translate && searchQ !== searchQuery) {
        try {
          const originalResults = await searchInnerTube(searchQuery, lang.code, region, page);
          rawVideos = [...rawVideos, ...originalResults];
        } catch (e) {
          // Supplementary search failed, continue with translated results
        }
      }
    } catch (err) {
      console.warn(`[BB] InnerTube failed for ${lang.name}, falling back to Invidious`);

      // Fallback to Invidious
      try {
        rawVideos = await searchInvidious(searchQ, lang.code, region, page, instances);
        backendUsed = 'invidious';

        if (queryInfo.translate && searchQ !== searchQuery) {
          const originalResults = await searchInvidious(searchQuery, lang.code, region, page, instances);
          rawVideos = [...rawVideos, ...originalResults];
        }
      } catch (err2) {
        console.error(`[BB] Both backends failed for ${lang.name}`);
        return [];
      }
    }

    if (rawVideos.length === 0) {
      console.warn(`[BB] No results for ${lang.name} from ${backendUsed}`);
      return [];
    }

    // Deduplicate within this language
    const seenLocal = new Set();
    const uniqueVideos = rawVideos.filter(v => {
      if (seenLocal.has(v.id)) return false;
      seenLocal.add(v.id);
      return true;
    });

    // Tag with language info and backend source
    uniqueVideos.forEach(v => {
      v.language = lang;
      v.queryUsed = searchQ;
      v.instanceUsed = v.instanceUsed || backendUsed;
    });

    // Batch translate titles for language detection (for non-English target languages)
    if (lang.code !== 'en') {
      await batchTranslateTitles(uniqueVideos, lang.code);
    }

    // Step 4: Language detection — filter by actual content language
    const langFiltered = uniqueVideos.filter(v => {
      const classification = classifyVideoLanguage(v, lang.code);
      v.langConfidence = classification.confidence;
      v.langSource = classification.source;

      // For non-Latin script languages, require higher confidence
      if (!LANG_SCRIPTS[lang.code]?.includes('latin')) {
        return classification.match && classification.confidence >= 0.2;
      }
      // For Latin script languages, be more lenient (harder to detect)
      return classification.match;
    });

    console.log(`[BB] ${lang.name}: ${rawVideos.length} raw → ${uniqueVideos.length} unique → ${langFiltered.length} lang-filtered (${backendUsed})`);

    return langFiltered.slice(0, maxResults);
  });

  const resultsByLang = await Promise.all(fetchPromises);
  let aggregated = resultsByLang.flat();

  // Step 5: Exclude English if configured
  if (excludeEnglish) {
    const before = aggregated.length;
    aggregated = aggregated.filter(v => !isLikelyEnglish(v));
    console.log(`[BB] Exclude English: ${before} → ${aggregated.length}`);
  }

  // Step 6: Global dedup across languages and pages
  const deduplicated = aggregated.filter(v => {
    if (globalSeenIds.has(v.id)) return false;
    globalSeenIds.add(v.id);
    return true;
  });

  console.log(`[BB] Final: ${aggregated.length} → ${deduplicated.length} after dedup (global: ${globalSeenIds.size})`);
  return deduplicated;
}

// ============================================================
// UTILITY HELPERS
// ============================================================

function parsePublishedTextToSeconds(text) {
  if (!text) return 9999999999;
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
  if (!match) return 9999999999;
  const val = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
  for (const [key, mult] of Object.entries(multipliers)) {
    if (unit.startsWith(key)) return val * mult;
  }
  return val;
}

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

function formatViews(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M views';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K views';
  return num + ' views';
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
        innerTubeContinuations = {};
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
