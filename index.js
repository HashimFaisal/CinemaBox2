'use strict';

// Bundled provider core: Nuvio loads the manifest's single index.js entrypoint.
var createProviderEngine = (function () {
  'use strict';
  
  const QUALITY = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };
  
  function normalizeQuality(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return 'Video';
    let match = raw.match(/^(?:4\s*k|uhd)(?:\s+(.+))?$/i);
    if (match) return '2160p' + (match[1] ? ' ' + match[1].trim() : '');
    match = raw.match(/^(\d{3,4})\s*p(?:\s+(.+))?$/i) || raw.match(/^(\d{3,4})p$/i);
    return match ? match[1] + 'p' + (match[2] ? ' ' + match[2].trim() : '') : raw;
  }
  
  function qualityRank(value) {
    const match = normalizeQuality(value).match(/^(\d{3,4})p/i);
    return match ? Number(match[1]) : (QUALITY[String(value).toLowerCase()] || -1);
  }
  
  function validHttpUrl(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || /\s|\\/.test(value)) return false;
    const protocolEnd = value.indexOf('://');
    if (protocolEnd < 0) return false;
    const protocol = value.slice(0, protocolEnd).toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') return false;
    const authority = value.slice(protocolEnd + 3).split(/[/?#]/, 1)[0];
    if (!authority) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        Boolean(parsed.hostname) && !parsed.username && !parsed.password;
    } catch (_) { return false; }
  }
  
  function streamRejectionReason(stream) {
    if (!stream || typeof stream !== 'object') return 'invalid-item';
    if (typeof stream.url !== 'string' || !stream.url) return 'missing-url';
    if (!validHttpUrl(stream.url)) return 'invalid-url';
    return null;
  }
  
  function normalizeStream(stream, provider) {
    if (!stream || !validHttpUrl(stream.url)) return null;
    const quality = normalizeQuality(stream.quality || stream.resolution);
    const label = String(provider.name || provider.id) + ' ' + quality;
    const output = {
      name: String(stream.name || label),
      title: String(stream.title || label),
      url: stream.url,
      quality: quality,
      providerId: provider.id
    };
    if (stream.language) output.language = String(stream.language);
    if (Number.isFinite(Number(stream.sizeBytes)) && Number(stream.sizeBytes) > 0) output.sizeBytes = Number(stream.sizeBytes);
    if (Number.isFinite(Number(stream.seeders)) && Number(stream.seeders) >= 0) output.seeders = Number(stream.seeders);
    return output;
  }
  
  function createProviderEngine(options) {
    const config = options || {};
    const providers = Array.isArray(config.providers) ? config.providers.slice() : [];
    const concurrency = Math.max(1, Math.floor(config.maxConcurrency || 3));
    const defaultTimeoutMs = Math.max(100, config.providerTimeoutMs || 8000);
    const failureThreshold = Math.max(1, Math.floor(config.failureThreshold || 2));
    const cooldownMs = Math.max(100, config.cooldownMs || 30000);
    const maxCooldownMs = Math.max(cooldownMs, Number(config.maxCooldownMs) || 300000);
    const now = config.now || Date.now;
    const schedule = config.setTimeout || (typeof setTimeout === 'function' ? setTimeout : function () { return null; });
    const cancel = config.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    const health = new Map();
  
    providers.forEach(provider => {
      if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(provider.id || '')) ||
          typeof provider.getStreams !== 'function') throw new TypeError('Invalid provider contract');
      if (!health.has(provider.id)) health.set(provider.id, {
        failures: 0, openUntil: 0, attempts: 0, successes: 0, validStreams: 0,
        emptyResponses: 0, errorCount: 0, timeoutCount: 0, rejectedStreams: 0,
        latencyEwmaMs: null, lastStatus: 'never', lastCooldownMs: 0
      });
    });
  
    async function runOne(provider, context) {
      const state = health.get(provider.id);
      if (provider.enabled === false) return { providerId: provider.id, status: 'disabled', streams: [] };
      if (typeof provider.supports === 'function' && !provider.supports(context)) {
        return { providerId: provider.id, status: 'unsupported', streams: [] };
      }
      if (state.openUntil > now()) return { providerId: provider.id, status: 'circuit-open', streams: [] };
      const providerTimeoutMs = Math.max(100, Number(provider.timeoutMs) || defaultTimeoutMs);
      const deadline = Math.min(Number.isFinite(context.deadline) ? context.deadline : Infinity, now() + providerTimeoutMs);
      if (deadline <= now()) return { providerId: provider.id, status: 'deadline-exceeded', streams: [] };
      const providerStartedAt = now();
      state.attempts += 1;
      console.log('[ENGINE TRACE] provider-start', provider.id, 'at:', providerStartedAt);
  
        let timer;
      let timedOut = false;
      try {
        const work = Promise.resolve().then(() => provider.getStreams(Object.assign({}, context, {
          providerId: provider.id, deadline: deadline
        })));
        // Embedded runtimes may retain completed timeout handles after clearTimeout.
        let result;
        if (provider.skipTimeoutTimer === true) {
          result = await work;
        } else {
          const timeout = new Promise((_, reject) => {
            timer = schedule(() => { timedOut = true; reject(new Error('PROVIDER_TIMEOUT')); }, Math.max(1, deadline - now()));
          });
          result = await Promise.race([work, timeout]);
          cancel(timer);
        }
        console.log('[ENGINE TRACE] provider-settled', provider.id, 'elapsedMs:', now() - providerStartedAt, 'timedOut:', timedOut);
        const elapsedMs = Math.max(0, now() - providerStartedAt);
        state.failures = 0;
        state.openUntil = 0;
        state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs : (state.latencyEwmaMs * 0.7) + (elapsedMs * 0.3);
        const raw = Array.isArray(result) ? result : (result && Array.isArray(result.streams) ? result.streams : []);
        const streams = [];
        const rejectionReasons = {};
        raw.forEach(item => {
          const normalized = normalizeStream(item, provider);
          if (normalized) {
            streams.push(normalized);
          } else {
            const reason = streamRejectionReason(item) || 'invalid-stream';
            rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
          }
        });
        const rejectedStreams = raw.length - streams.length;
        state.rejectedStreams += rejectedStreams;
        if (streams.length > 0) state.successes += 1;
        else state.emptyResponses += 1;
        state.lastStatus = streams.length > 0 ? 'ok' : 'empty';
        state.validStreams += streams.length;
        return {
          providerId: provider.id,
          status: state.lastStatus,
          elapsedMs: elapsedMs,
          rawStreams: raw.length,
          rejectedStreams: rejectedStreams,
          rejectionReasons: rejectionReasons,
          streams: streams
        };
      } catch (error) {
        console.error('[ENGINE TRACE] provider-error', provider.id, 'elapsedMs:', now() - providerStartedAt, 'timedOut:', timedOut, 'error:', String(error && error.message || error));
        if (timer !== undefined) cancel(timer);
        const elapsedMs = Math.max(0, now() - providerStartedAt);
        state.failures += 1;
        state.errorCount += 1;
        if (timedOut) state.timeoutCount += 1;
        state.lastStatus = timedOut ? 'timeout' : 'error';
        state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs : (state.latencyEwmaMs * 0.7) + (elapsedMs * 0.3);
        if (state.failures >= failureThreshold) {
          const exponent = Math.min(10, state.failures - failureThreshold);
          state.lastCooldownMs = Math.min(maxCooldownMs, cooldownMs * Math.pow(2, exponent));
          state.openUntil = now() + state.lastCooldownMs;
        }
        return { providerId: provider.id, status: state.lastStatus, elapsedMs: elapsedMs, streams: [] };
      }
    }
  
    async function getStreams(context) {
      const engineStartedAt = now();
      console.log('[ENGINE TRACE] engine-start', 'providers:', providers.length);
      const input = context || {};
      const results = new Array(providers.length);
      const primaryIndexes = [];
      const fallbackIndexes = [];
      providers.forEach((provider, index) => {
        (provider.fallbackOnlyWhenEmpty === true ? fallbackIndexes : primaryIndexes).push(index);
      });
      async function runIndexes(indexes) {
        let cursor = 0;
        async function worker() {
          while (true) {
            const position = cursor++;
            if (position >= indexes.length) return;
            const index = indexes[position];
            results[index] = await runOne(providers[index], input);
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, () => worker()));
      }
      await runIndexes(primaryIndexes);
      const primaryHasStreams = primaryIndexes.some(index =>
        results[index] && results[index].streams.length > 0
      );
      if (!primaryHasStreams && fallbackIndexes.length) await runIndexes(fallbackIndexes);
      fallbackIndexes.forEach(index => {
        if (!results[index]) results[index] = {
          providerId: providers[index].id,
          status: 'skipped-primary-success',
          streams: []
        };
      });
      const seen = new Set();
      const streams = [];
      results.forEach(result => result.streams.forEach(stream => {
        if (seen.has(stream.url)) return;
        seen.add(stream.url);
        streams.push(stream);
      }));
      streams.sort((a, b) => {
        const rank = qualityRank(b.quality) - qualityRank(a.quality);
        if (rank) return rank;
        const pa = providers.find(item => item.id === a.providerId);
        const pb = providers.find(item => item.id === b.providerId);
        const priorityDifference = Number(pb && pb.priority || 0) - Number(pa && pa.priority || 0);
        if (priorityDifference) return priorityDifference;
        const ha = health.get(a.providerId);
        const hb = health.get(b.providerId);
        const rateA = ha && ha.attempts ? ha.successes / ha.attempts : 0.5;
        const rateB = hb && hb.attempts ? hb.successes / hb.attempts : 0.5;
        if (rateB !== rateA) return rateB - rateA;
        const latencyA = ha && ha.latencyEwmaMs != null ? ha.latencyEwmaMs : Infinity;
        const latencyB = hb && hb.latencyEwmaMs != null ? hb.latencyEwmaMs : Infinity;
        return latencyA - latencyB;
      });
      return { streams: streams, providers: results };
    }
  
    function getHealth() {
      const snapshot = {};
      health.forEach((state, id) => {
        snapshot[id] = {
          failures: state.failures, circuitOpen: state.openUntil > now(),
          retryAt: state.openUntil > now() ? state.openUntil : null,
          cooldownMs: state.lastCooldownMs,
          attempts: state.attempts, successes: state.successes,
          successRate: state.attempts ? state.successes / state.attempts : null,
          productiveRate: state.attempts ? state.successes / state.attempts : null,
          emptyResponses: state.emptyResponses, errorCount: state.errorCount,
          timeoutCount: state.timeoutCount, rejectedStreams: state.rejectedStreams,
          validStreams: state.validStreams, latencyEwmaMs: state.latencyEwmaMs,
          lastStatus: state.lastStatus
        };
      });
      return snapshot;
    }
    return { getStreams: getStreams, getHealth: getHealth };
  }
  
  return createProviderEngine;
})();

const BASE = 'https://cinema.albox.co/api/v4';
const CINEMETA = 'https://v3-cinemeta.strem.io';

function redactSensitive(value) {
  var text = String(value == null ? '' : value)
    .replace(/([?&]api_key=)[^&]*/gi, '$1[REDACTED]');
  var key = typeof TMDB_API_KEY !== 'undefined' ? String(TMDB_API_KEY || '') : '';
  if (key) text = text.split(key).join('[REDACTED]');
  return text;
}

const cache = new Map();
const CACHE_MAX_ENTRIES = 500;
const DETAILS_CACHE_TTL_MS = 300000;
const PLAYER_CACHE_TTL_MS = 30000;
const SEARCH_CACHE_TTL_MS = 600000;
const METADATA_CACHE_TTL_MS = 600000;
const PROVIDER_BUDGET_MS = 45000;
const SEARCH_MAX_PAGES = 3;

function ensureBudget(deadline, stage) {
  if (deadline && Date.now() >= deadline) {
    throw new Error('CinemaBox time budget exceeded before ' + stage);
  }
}

function cached(key, loader, ttl) {
  if (ttl == null) ttl = DETAILS_CACHE_TTL_MS;
  var now = Date.now();
  var old = cache.get(key);

  if (old && (old.pending || now < old.expiresAt)) {
    // Share in-flight work and refresh LRU order for every cache hit.
    console.log('[CACHE]', 'hit', 'kind:', String(key).split('-')[0], 'pending:', old.pending);
    cache.delete(key);
    cache.set(key, old);
    return old.value;
  }
  if (old) {
    console.log('[CACHE]', 'expired', 'kind:', String(key).split('-')[0]);
    cache.delete(key);
  } else {
    console.log('[CACHE]', 'miss', 'kind:', String(key).split('-')[0]);
  }

  var entry = { time: now, expiresAt: 0, pending: true, value: null };
  var value = Promise.resolve().then(loader).then(function (result) {
    // Start the TTL after successful completion, not when a slow request began.
    if (cache.get(key) === entry) {
      entry.time = Date.now();
      entry.expiresAt = entry.time + Math.max(0, ttl);
      entry.pending = false;
    }
    return result;
  }).catch(function (error) {
    // A late failure must never evict a newer entry for the same key.
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });

  entry.value = value;
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}

function validateStreamUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      value.indexOf('\\') !== -1 || /\s/.test(value)) return false;
  // Reject empty authorities before WHATWG URL parsing normalizes malformed slashes.
  var protocolEnd = value.indexOf('://');
  if (protocolEnd < 0) return false;
  var protocol = value.slice(0, protocolEnd).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') return false;
  var authority = value.slice(protocolEnd + 3).split(/[/?#]/, 1)[0];
  if (!authority) return false;
  try {
    var parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!parsed.hostname || parsed.username || parsed.password) return false;
    return true;
  } catch (error) {
    return false;
  }
}

function uniqueStreamVideos(videos) {
  var seen = new Set();
  return (Array.isArray(videos) ? videos : []).filter(function (video) {
    if (!video || !validateStreamUrl(video.url)) return false;
    // Keep the original URL untouched: signed query strings may be order-sensitive.
    // A repeated URL is one endpoint, not an additional quality.
    if (seen.has(video.url)) return false;
    seen.add(video.url);
    return true;
  });
}

function normalizeQuality(value) {
  if (value == null || value === '') return 'Video';
  var quality = String(value).trim();
  if (!quality) return 'Video';

  // Normalize common UHD labels into Nuvio's canonical 2160p quality.
  // Preserve HDR/Dolby Vision suffixes instead of silently discarding them.
  var suffix = '';
  var match = quality.match(/^(?:4\s*k|uhd)(?:\s+(.+))?$/i);
  if (match) {
    suffix = match[1] ? ' ' + match[1].trim() : '';
    return '2160p' + suffix;
  }

  match = quality.match(/^(?:3840|4096)\s*[x×]\s*2160(?:p)?(?:\s+(.+))?$/i);
  if (match) {
    suffix = match[1] ? ' ' + match[1].trim() : '';
    return '2160p' + suffix;
  }

  match = quality.match(/^(\d{3,4})\s*p(?:\s+(.+))?$/i);
  if (match) {
    suffix = match[2] ? ' ' + match[2].trim() : '';
    return match[1] + 'p' + suffix;
  }
  return quality;
}
function diagnostic(stage, code, type, id, error) {
  var message = error && error.message ? error.message : (error == null ? '' : String(error));
  var detail = {
    stage: stage,
    code: code,
    type: type || 'unknown',
    id: id || 'unknown'
  };
  if (message) detail.message = redactSensitive(message);
  console.error('[CINEMABOX DIAGNOSTIC]', JSON.stringify(detail));
}

function request(url, deadline) {
  ensureBudget(deadline, 'HTTP request');
  var requestStart = Date.now();
  var timingLogged = false;
  var requestLabel = 'unknown';
  try {
    var parsedUrl = new URL(url);
    requestLabel = parsedUrl.hostname + parsedUrl.pathname;
  } catch (error) {
    requestLabel = 'invalid-url';
  }

  return fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Referer': 'https://cinema.albox.co/',
      'Origin': 'https://cinema.albox.co',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  })
  .then(function (response) {
    return response.text().then(function (body) {
      timingLogged = true;
      console.log('[HTTP TIMING]', requestLabel, 'status:', response.status,
        'ms:', Date.now() - requestStart, 'bytes:', body.length);
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + redactSensitive(url) + ' | BODY: ' + redactSensitive(body.slice(0, 700)));
      }
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new Error('Invalid JSON from ' + redactSensitive(url) + ': ' + redactSensitive(body.slice(0, 300)));
      }
    });
  })
  .catch(function (error) {
    if (!timingLogged) {
      console.log('[HTTP TIMING]', requestLabel, 'status: failed',
        'ms:', Date.now() - requestStart);
    }
    throw error;
  });
}

function requestWithRetry(url, deadline, maxRetries) {
  var retries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 1;

  function attempt(index) {
    ensureBudget(deadline, 'retryable HTTP request');
    return request(url, deadline).catch(function (error) {
      var message = String(error && error.message || error);
      var retryable = /HTTP (?:408|425|429|500|502|503|504)\b/.test(message) ||
        /network|fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message);
      if (!retryable || index >= retries) throw error;

      var delay = 200 * (index + 1);
      console.log('[HTTP RETRY]', 'attempt:', index + 2,
        'maxAttempts:', retries + 1, 'delayMs:', delay,
        'reason:', /HTTP \d+/.test(message) ? message.match(/HTTP \d+/)[0] : 'network');
      return new Promise(function (resolve) {
        setTimeout(resolve, delay);
      }).then(function () {
        ensureBudget(deadline, 'HTTP retry');
        return attempt(index + 1);
      });
    });
  }

  return attempt(0);
}

function api(path, deadline) {
  return request(BASE + '/' + path, deadline);
}

function normalizeType(value) {
  var type = String(value || '').toUpperCase();
  if (type === 'MOVIE' || type === 'FILM') return 'movie';
  if (type === 'TV' || type === 'SERIES' || type === 'SHOW') return 'series';
  return null;
}

// دالة آمنة لتنظيف النصوص تدعم العربية بدون استخدام normalize
function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleScore(a, b) {
  var x = normalizeTitle(a);
  var y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  var xs = new Set(x.split(' '));
  var ys = new Set(y.split(' '));
  var common = 0;
  xs.forEach(function (word) { if (ys.has(word)) common++; });
  return (2 * common) / (xs.size + ys.size);
}

function releaseYear(value) {
  if (!value) return undefined;
  var number = Number(value);
  if (Number.isFinite(number) && number > 1000000000) {
    return String(new Date(number).getFullYear());
  }
  var match = String(value).match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : undefined;
}

function getDetails(id, seasonId, deadline) {
  var suffix = seasonId ? '?season_id=' + encodeURIComponent(seasonId) : '';
  var key = 'details-' + id + '-' + (seasonId || 'default');
  return cached(key, function () {
    console.log('[DETAILS FETCH]', 'show:', id, 'seasonId:', seasonId || 'default');
    return requestWithRetry(BASE + '/shows/shows/dynamic/' + id + suffix, deadline, 1);
  }, DETAILS_CACHE_TTL_MS);
}

function getPlayer(episodeId, deadline) {
  return cached('player-' + episodeId, function () {
    return requestWithRetry(BASE + '/shows/episodes/player/' + episodeId, deadline, 1);
  }, PLAYER_CACHE_TTL_MS);
}

function getExternalMeta(type, id, deadline) {
  return cached('external-' + type + '-' + id, function () {
    return requestWithRetry(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json', deadline, 1).then(function (data) {
      if (!data.meta || !data.meta.name) throw new Error('No external metadata for ' + id);
      return data.meta;
    });
  }, METADATA_CACHE_TTL_MS);
}

function searchCinemaBox(title, type, year, deadline) {
  return cached('search-' + type + '-' + normalizeTitle(title) + '-' + (year || ''), function () {
    var foundItems = new Map();
    var failedPageCount = 0;

    function rankItems(items) {
      var queryTitle = normalizeTitle(title);
      var ranked = [];
      items.forEach(function (item) {
        var candidateTitle = normalizeTitle(item.title);
        var rawTitleScore = titleScore(title, item.title);
        var score = rawTitleScore;
        var resultYear = releaseYear(item.year);

        if (queryTitle !== candidateTitle && queryTitle.split(' ').length === 1 && candidateTitle.split(' ').length > 1) {
          score = 0;
        }

        if (year && resultYear && resultYear !== '1900') {
          if (year === resultYear) score += 0.1;
          else score -= 0.1;
        }
        ranked.push({ item: item, score: score, titleScore: rawTitleScore, resultYear: resultYear });
      });
      ranked.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (b.titleScore !== a.titleScore) return b.titleScore - a.titleScore;
        var aYearMatch = year && a.resultYear === year ? 1 : 0;
        var bYearMatch = year && b.resultYear === year ? 1 : 0;
        if (bYearMatch !== aYearMatch) return bYearMatch - aYearMatch;
        return String(a.item.id).localeCompare(String(b.item.id));
      });
      return ranked[0] || null;
    }

    var pageRequests = new Map();

    function fetchSearchPage(term, pageNum) {
      ensureBudget(deadline, 'search page ' + pageNum);
      var requestKey = String(term) + '::' + pageNum;
      if (pageRequests.has(requestKey)) return pageRequests.get(requestKey);
      var queryStr = 'page_size=25&page_number=' + pageNum + '&term=' + encodeURIComponent(term);
      function attempt(retry) {
        return api('search?' + queryStr, deadline).catch(function (error) {
          var message = String(error && error.message || error);
          var retryable = !/HTTP (?:400|401|403|404|405|410|422)\b/.test(message);
          if (retry < 1 && retryable) {
            console.log('[SEARCH PAGE RETRY]', 'term:', term, 'page:', pageNum);
            return attempt(retry + 1);
          }
          failedPageCount++;
          console.log('[SEARCH PAGE ERROR]', term, 'page', pageNum,
            error && error.message ? redactSensitive(error.message) : redactSensitive(error));
          return null;
        });
      }
      var pending = attempt(0);
      pageRequests.set(requestKey, pending);
      return pending;
    }

    function addResults(data, termItems) {
      var pageResults = Array.isArray(data && data.results) ? data.results : [];
      pageResults.filter(function (item) {
        return normalizeType(item.type) === type;
      }).forEach(function (item) {
        if (item.id) {
          foundItems.set(String(item.id), item);
          if (termItems) termItems.set(String(item.id), item);
        }
      });
      return pageResults.length;
    }

    // ابدأ ببحث الاسم فقط؛ استخدم الاسم مع السنة كاحتياط عند غياب التطابق القوي.
    function fetchFirstPage(term) {
      var termItems = new Map();
      return fetchSearchPage(term, 1).then(function (data) {
        console.log('[SEARCH TRACE] first-page-json-ready', 'term:', term, 'hasData:', Boolean(data), 'at:', Date.now());
        var before = foundItems.size;
        var count = data ? addResults(data, termItems) : 0;
        var best = rankItems(Array.from(termItems.values()));
        console.log('[SEARCH PAGE]', 'term:', term, 'page:', 1, 'returned:', count,
          'newUnique:', foundItems.size - before,
          'best:', best ? best.item.title : 'none',
          'titleScore:', best ? best.titleScore.toFixed(2) : 'n/a',
          'score:', best ? best.score.toFixed(2) : 'n/a',
          'year:', best ? (best.resultYear || 'unknown') : 'n/a');
        return { count: count, best: best };
      });
    }

    function fetchMorePages(term, pageNum) {
      if (pageNum > SEARCH_MAX_PAGES) return Promise.resolve();

      // Fetch two adjacent pages together to avoid serial network round trips.
      // Keep the same five-page ceiling and the same strong-match stop rule.
      var pageNumbers = [pageNum, pageNum + 1].filter(function (number) {
        return number <= SEARCH_MAX_PAGES;
      });

      return Promise.all(pageNumbers.map(function (number) {
        return fetchSearchPage(term, number);
      })).then(function (pages) {
        // Merge in page order so equal-score tie-breaking remains deterministic.
        var counts = pages.map(function (data, index) {
          var before = foundItems.size;
          var count = data ? addResults(data) : 0;
          var bestOnPage = rankItems(Array.from(foundItems.values()));
          console.log('[SEARCH PAGE]', 'term:', term, 'page:', pageNumbers[index],
            'returned:', count, 'newUnique:', foundItems.size - before,
            'best:', bestOnPage ? bestOnPage.item.title : 'none',
            'titleScore:', bestOnPage ? bestOnPage.titleScore.toFixed(2) : 'n/a',
            'score:', bestOnPage ? bestOnPage.score.toFixed(2) : 'n/a',
            'year:', bestOnPage ? (bestOnPage.resultYear || 'unknown') : 'n/a');
          return count;
        });
        var best = rankItems(Array.from(foundItems.values()));
        if (best && best.titleScore >= 0.75 && best.score >= 0.75) {
          console.log('[SEARCH STOP]', 'reason: strong-score', 'score:', best.score.toFixed(2));
          return;
        }
        var hadPageFailure = pages.some(function (data) { return data === null; });
        if (!hadPageFailure && counts.some(function (count) { return count < 25; })) {
          console.log('[SEARCH STOP]', 'reason: last-page', 'returned:', counts);
          return;
        }
        if (hadPageFailure) {
          console.log('[SEARCH PAGINATION]', 'reason: continue-after-page-error', 'pages:', pageNumbers);
        }
        return fetchMorePages(term, pageNum + pageNumbers.length);
      });
    }

    return fetchFirstPage(title).then(function (firstPage) {
      var firstCount = firstPage.count;
      var firstBest = firstPage.best;
      var best = rankItems(Array.from(foundItems.values()));
      if (best && best.titleScore >= 0.75 && best.score >= 0.75) {
        console.log('[SEARCH STOP]', 'reason: first-page-strong-match', 'title:', best.item.title,
          'titleScore:', best.titleScore.toFixed(2), 'score:', best.score.toFixed(2));
        return;
      }

      console.log('[SEARCH FALLBACK]', 'reason:', best ? 'best-score-below-0.95' : 'no-results',
        'query:', title, 'year:', year || 'none',
        'best:', best ? best.item.title : 'none',
        'titleScore:', best ? best.titleScore.toFixed(2) : 'n/a',
        'score:', best ? best.score.toFixed(2) : 'n/a');
      var fallbackTerm = year ? title + ' ' + year : null;
      var fallbackSearch = fallbackTerm ? fetchFirstPage(fallbackTerm) : Promise.resolve({ count: 0, best: null });

      return fallbackSearch.then(function (fallbackPage) {
        var fallbackCount = fallbackPage.count;
        best = rankItems(Array.from(foundItems.values()));
        if (best && best.titleScore >= 0.75 && best.score >= 0.75) {
          console.log('[SEARCH STOP]', 'reason: fallback-strong-match', 'title:', best.item.title,
            'titleScore:', best.titleScore.toFixed(2), 'score:', best.score.toFixed(2));
          return;
        }

        console.log('[SEARCH PAGINATION]', 'reason: no-strong-match-after-first-pages',
          'best:', best ? best.item.title : 'none',
          'titleScore:', best ? best.titleScore.toFixed(2) : 'n/a',
          'score:', best ? best.score.toFixed(2) : 'n/a');
        // Paginate only the first-page query that produced the better candidate.
        // This avoids expanding both the plain-title and year-fallback searches.
        var useFallback = fallbackTerm && fallbackCount >= 25 && fallbackPage.best &&
          (!firstBest || fallbackPage.best.score > firstBest.score);
        var paginationTerm = useFallback ? fallbackTerm : title;
        var paginationCount = useFallback ? fallbackCount : firstCount;
        if (paginationCount >= 25) return fetchMorePages(paginationTerm, 2);
        return Promise.resolve();
      });
    }).then(function () {
      var best = rankItems(Array.from(foundItems.values()));
      if (best && best.titleScore >= 0.75 && best.score >= 0.75) {
        console.log('[MATCH]', title, '=>', best.item.title, 'ID:', best.item.id, 'score:', best.score.toFixed(2));
        return best.item;
      }
      if (failedPageCount > 0) {
        throw new Error('CinemaBox search incomplete: ' + failedPageCount + ' page request(s) failed');
      }
      console.log('[NOT FOUND]', title, year, type);
      return null;
    });
  }, SEARCH_CACHE_TTL_MS);
}

function searchCinemaBoxTitles(primaryTitle, alternateTitle, type, year, deadline) {
  var titles = [String(primaryTitle || '').trim()];
  var alternate = String(alternateTitle || '').trim();
  if (alternate && normalizeTitle(alternate) !== normalizeTitle(titles[0])) {
    titles.push(alternate);
  }

  // Run title variants concurrently. Return an exact alternate immediately,
  // but do not let a merely fuzzy alternate beat a potentially exact primary match.
  // Avoid timer-based arbitration because embedded Nuvio runtimes may delay timers.
  var completed = false;
  var settled = 0;
  var firstError = null;
  var bestCandidate = null;
  var bestTitle = '';
  var bestConfidence = -Infinity;

  function confidenceFor(item) {
    var confidence = Math.max(titleScore(primaryTitle, item.title),
      alternate ? titleScore(alternate, item.title) : 0);
    var itemYear = releaseYear(item.year);
    if (year && itemYear && itemYear !== '1900') {
      confidence += itemYear === String(year) ? 0.1 : -0.1;
    }
    return confidence;
  }

  function finish(item, title, reason, confidence) {
    if (completed) return item;
    completed = true;
    console.log('[SEARCH PARALLEL MATCH]', 'query:', title,
      'title:', item.title, 'strategy:', reason,
      'confidence:', confidence.toFixed(2),
      'completedQueries:', settled, 'totalQueries:', titles.length);
    return item;
  }

  return new Promise(function (resolve, reject) {
    function settleIfComplete() {
      if (completed || settled !== titles.length) return;
      if (bestCandidate) {
        resolve(finish(bestCandidate, bestTitle, 'best-completed-candidate', bestConfidence));
      } else if (firstError) {
        completed = true;
        reject(firstError);
      } else {
        completed = true;
        resolve(null);
      }
    }

    titles.forEach(function (title, index) {
      console.log('[SEARCH PARALLEL]', 'query:', title, 'index:', index);
      searchCinemaBox(title, type, year, deadline).then(function (item) {
        settled++;
        console.log('[SEARCH TRACE] query-settled', 'query:', title,
          'hasItem:', Boolean(item), 'hasError:', false, 'at:', Date.now());
        if (completed || !item) {
          settleIfComplete();
          return;
        }

        var confidence = confidenceFor(item);
        if (confidence > bestConfidence) {
          bestCandidate = item;
          bestTitle = title;
          bestConfidence = confidence;
        }

        // The primary query is authoritative. An alternate may short-circuit only
        // when its candidate is an exact title match (year bonus may raise it to 1.1).
        var exactAlternate = index > 0 && titleScore(title, item.title) >= 1;
        if (index === 0 || exactAlternate) {
          resolve(finish(item, title,
            index === 0 ? 'primary-title-match' : 'exact-alternate-match',
            confidence));
          return;
        }

        console.log('[SEARCH PARALLEL DEFER]', 'query:', title,
          'confidence:', confidence.toFixed(2),
          'reason: fuzzy-alternate-await-primary');
        settleIfComplete();
      }).catch(function (error) {
        settled++;
        console.log('[SEARCH TRACE] query-settled', 'query:', title,
          'hasItem:', false, 'hasError:', true, 'at:', Date.now());
        if (completed) return;
        if (!firstError) firstError = error;
        settleIfComplete();
      });
    });
  });
}

function parseExternalId(id) {
  var match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/);
  if (!match) return null;
  return {
    imdbId: match[1],
    season: match[2] ? Number(match[2]) : null,
    episode: match[3] ? Number(match[3]) : null
  };
}

function findEpisode(details, showId, seasonNumber, episodeNumber, deadline) {
  var seasonDetails = details;
  var rawCurrentSeason = details.post_info && details.post_info.season_number;
  var parsedCurrentSeason = rawCurrentSeason == null || rawCurrentSeason === ''
    ? NaN : Number(rawCurrentSeason);
  // Season 0 is valid (specials); only absent or invalid metadata is unknown.
  var currentSeason = Number.isInteger(parsedCurrentSeason) && parsedCurrentSeason >= 0
    ? parsedCurrentSeason : null;
  var seasonPromise = Promise.resolve(seasonDetails);

  console.log('[SEASON RESOLVE]', 'requested:', seasonNumber,
    'current:', currentSeason == null ? 'unknown' : currentSeason,
    'requiresSeasonFetch:', currentSeason !== seasonNumber);

  if (currentSeason !== seasonNumber) {
    var seasonCards = [];
    (details.sections || []).forEach(function (section) {
      (section.data || []).forEach(function (item) {
        if (String(item.card_type || '').toLowerCase() === 'seasonposter' && item.id) {
          seasonCards.push(item);
        }
      });
    });

    var seasonCard = null;
    for (var i = 0; i < seasonCards.length; i++) {
      var seasonTitle = String(seasonCards[i].title || '').trim();
      var match = seasonTitle.match(/\d+/);
      var cardSeason = /^specials?$/i.test(seasonTitle)
        ? 0 : (match ? Number(match[0]) : null);
      if (cardSeason === seasonNumber) {
        seasonCard = seasonCards[i];
        break;
      }
    }

    if (!seasonCard) {
      console.log('[SEASON NOT AVAILABLE]', 'requested:', seasonNumber,
        'reason:', currentSeason == null ? 'season-metadata-missing' : 'season-card-missing');
      return Promise.resolve(null);
    }

    var seasonLoadStart = Date.now();
    ensureBudget(deadline, 'season details');
    seasonPromise = getDetails(showId, seasonCard.id, deadline).then(function (loaded) {
      console.log('[TIMING] season details:', Date.now() - seasonLoadStart,
        'ms', 'season:', seasonNumber, 'seasonId:', seasonCard.id);
      var rawLoadedSeason = loaded && loaded.post_info && loaded.post_info.season_number;
      var loadedSeason = rawLoadedSeason == null || rawLoadedSeason === ''
        ? NaN : Number(rawLoadedSeason);
      if (!Number.isInteger(loadedSeason) || loadedSeason < 0 || loadedSeason !== seasonNumber) {
        console.log('[SEASON LOAD MISMATCH]', 'requested:', seasonNumber,
          'loaded:', Number.isInteger(loadedSeason) ? loadedSeason : 'unknown');
        return null;
      }
      return loaded;
    });
  }

  return seasonPromise.then(function (sd) {
    if (!sd) return null;
    var section = null;
    (sd.sections || []).forEach(function (s) {
      if (s.section_type === 'episodes' || (s.data || []).some(function (item) {
        return String(item.card_type || '').toLowerCase() === 'episode';
      })) {
        if (!section) section = s;
      }
    });

    var episodes = [];
    if (section) {
      (section.data || []).forEach(function (item) {
        if (item.id && String(item.card_type || '').toLowerCase() === 'episode') {
          episodes.push(item);
        }
      });
    }

    function explicitEpisodeNumber(item) {
      var description = String(item.description == null ? '' : item.description).trim();
      if (/^\d+$/.test(description)) {
        var numeric = Number(description);
        return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
      }
      var labelled = description.match(/\b(?:episode|ep|e|special)\s*0*(\d+)\b/i) ||
        description.match(/\bs\s*0*\d+\s*e\s*0*(\d+)\b/i);
      if (!labelled) return null;
      var labelledNumber = Number(labelled[1]);
      return Number.isSafeInteger(labelledNumber) && labelledNumber > 0 ? labelledNumber : null;
    }

    var numbered = episodes.map(function (item) {
      return { item: item, number: explicitEpisodeNumber(item) };
    });
    var hasExplicitNumbers = numbered.some(function (entry) { return entry.number != null; });

    for (var idx = 0; idx < numbered.length; idx++) {
      // Positional fallback is safe only when the entire list has no explicit numbering.
      var number = hasExplicitNumbers ? numbered[idx].number : idx + 1;
      if (number === episodeNumber) return numbered[idx].item.id;
    }
    return null;
  });
}
function resolveImdbId(id, mediaType, deadline) {
  var value = String(id || '').replace(/^imdb:/i, '');
  if (/^tt\d+$/i.test(value)) return Promise.resolve(value);

  var kind = (String(mediaType).toLowerCase() === 'tv' || String(mediaType).toLowerCase() === 'series') ? 'tv' : 'movie';
  var detailsUrl = 'https://api.themoviedb.org/3/' + kind + '/' + encodeURIComponent(value);
  var key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';

  if (!key) {
    console.error('[TMDB] API key is unavailable in plugin runtime');
    return Promise.resolve(null);
  }

  var auth = '?api_key=' + encodeURIComponent(key);

  return request(detailsUrl + auth, deadline).then(function (data) {
    if (data && data.imdb_id) return data.imdb_id;

    return request(detailsUrl + '/external_ids' + auth, deadline)
      .then(function (external) {
        return external && external.imdb_id ? external.imdb_id : null;
      });
  });
}
function buildStream(video, displayTitle) {
  if (!video || !validateStreamUrl(video.url)) return null;
  var quality = normalizeQuality(video.quality);
  var streamLabel = 'CinemaBox (' + displayTitle + ') ' + quality;
  return {
    name: streamLabel,
    title: streamLabel,
    url: video.url,
    quality: quality
  };
}

function fetchStreams(type, id, suppliedMeta, deadline, throwOnError) {
  var timingStart = Date.now();
  var stageStart = timingStart;
  var episodeId = null;
  var displayTitle = '';
  var failureStage = 'metadata';
  var external = parseExternalId(id);

  if (!external) {
    diagnostic('input', 'UNSUPPORTED_ID', type, id);
    return Promise.resolve({ streams: [] });
  }

  var metaPromise = suppliedMeta
    ? Promise.resolve(suppliedMeta)
    : getExternalMeta(type, external.imdbId, deadline);

  return metaPromise.then(function (meta) {
    console.log('[FETCH TRACE] metadata-ready', 'elapsedMs:', Date.now() - timingStart);
    if (!meta || (!meta.name && !meta.original_name)) {
      diagnostic('metadata', 'METADATA_INCOMPLETE', type, id);
      return null;
    }
    displayTitle = String(meta.name || meta.original_name || external.imdbId);
    if (type === 'series' && external.season != null && external.episode != null) {
      var seasonLabel = String(external.season).padStart(2, '0');
      var episodeLabel = String(external.episode).padStart(2, '0');
      displayTitle += ' S' + seasonLabel + 'E' + episodeLabel;
    }
    console.log('[TIMING] metadata:', Date.now() - stageStart, 'ms');
    stageStart = Date.now();
    var year = releaseYear(meta.year);
    
    failureStage = 'search';
    ensureBudget(deadline, 'primary title search');
    console.log('[FETCH TRACE] search-start', 'at:', Date.now());
    return searchCinemaBoxTitles(
      meta.name || meta.original_name,
      meta.original_name,
      type,
      year,
      deadline
    ).then(function (found) {
      console.log('[FETCH TRACE] search-finish', 'elapsedMs:', Date.now() - stageStart, 'found:', Boolean(found));
      console.log('[TIMING] search:', Date.now() - stageStart, 'ms');
      stageStart = Date.now();
      return found;
    });
  })
  .then(function (found) {
    if (!found) {
      diagnostic('search', 'TITLE_NOT_FOUND', type, id);
      return null;
    }
    failureStage = 'details';
    ensureBudget(deadline, 'show details');
    console.log('[FETCH TRACE] details-start', 'at:', Date.now());
    return getDetails(found.id, null, deadline).then(function (details) {
      console.log('[FETCH TRACE] details-finish', 'elapsedMs:', Date.now() - stageStart);
      console.log('[TIMING] details:', Date.now() - stageStart, 'ms');
      stageStart = Date.now();
      var post = details.post_info;
      if (!post) {
        diagnostic('details', 'DETAILS_PAYLOAD_INCOMPLETE', type, id);
        return null;
      }

      if (type === 'movie') {
        episodeId = post.episode_id;
        return episodeId;
      }

      if (external.season == null || external.episode == null) {
        diagnostic('episode', 'EPISODE_NOT_SELECTED', type, id);
        return null;
      }
      failureStage = 'episode';
      return findEpisode(details, found.id, external.season, external.episode, deadline).then(function (resolved) {
        if (!resolved) diagnostic('episode', 'EPISODE_NOT_FOUND', type, id);
        return resolved;
      });
    });
  })
  .then(function (resolvedEpisodeId) {
    episodeId = resolvedEpisodeId;
    if (!episodeId) {
      console.log('[NO EPISODE ID]', type, id);
      return { streams: [] };
    }

    failureStage = 'player';
    ensureBudget(deadline, 'player lookup');
    console.log('[FETCH TRACE] player-start', 'episode:', episodeId, 'at:', Date.now());
    return getPlayer(episodeId, deadline).then(function (player) {
      console.log('[FETCH TRACE] player-finish', 'elapsedMs:', Date.now() - stageStart);
      console.log('[TIMING] player:', Date.now() - stageStart, 'ms');
      var streams = [];
      if (!player || !Array.isArray(player.videos)) {
        console.error('[CINEMABOX QUALITY AUDIT]', JSON.stringify({
          stage: 'player_response', status: 'invalid', rawVideos: null,
          validUniqueStreams: 0, qualities: [], has2160p: null
        }));
        diagnostic('player', 'PLAYER_PAYLOAD_INVALID', type, id,
          new Error('Expected videos array; received ' + (player && typeof player.videos)));
        return { streams: [] };
      }
      var playerVideos = player.videos;
      if (playerVideos.length === 0) {
        diagnostic('player', 'PLAYER_EMPTY', type, id);
      }
      console.log('[PLAYER DIAGNOSTICS]', type, id,
        'playerKeys:', Object.keys(player || {}),
        'videosType:', Array.isArray(player && player.videos) ? 'array' : typeof (player && player.videos),
        'videosCount:', playerVideos.length);
      var qualityCounts = Object.create(null);
      playerVideos.forEach(function (video, index) {
        var videoUrl = video && video.url;
        var validUrl = validateStreamUrl(videoUrl);
        var quality = normalizeQuality(video && video.quality);
        console.log('[PLAYER VIDEO]', 'index:', index,
          'urlValid:', validUrl,
          'quality:', quality);
      });
      uniqueStreamVideos(playerVideos).forEach(function (video) {
        var stream = buildStream(video, displayTitle);
        if (!stream) return;
        streams.push(stream);
        qualityCounts[stream.quality] = (qualityCounts[stream.quality] || 0) + 1;
      });
      console.log('[STREAM QUALITY SUMMARY]', JSON.stringify(qualityCounts));
      var rawQualities = [];
      var seenQualities = new Set();
      playerVideos.forEach(function (video) {
        var quality = normalizeQuality(video && video.quality);
        if (!seenQualities.has(quality)) {
          seenQualities.add(quality);
          rawQualities.push(quality);
        }
      });
      var has2160p = rawQualities.some(function (quality) {
        return /^2160p(?:\b|$)/i.test(String(quality).trim());
      });
      console.error('[CINEMABOX QUALITY AUDIT]', JSON.stringify({
        stage: 'player_response',
        status: 'ok',
        rawVideos: playerVideos.length,
        validUniqueStreams: streams.length,
        qualities: rawQualities,
        has2160p: has2160p
      }));
      if (playerVideos.length > 0 && streams.length === 0) {
        diagnostic('player', 'NO_VALID_STREAM_URLS', type, id);
      }
      console.log('[STREAMS]', type, id, 'episode:', episodeId,
        'rawVideos:', playerVideos.length, 'uniqueValid:', streams.length,
        'total:', Date.now() - timingStart, 'ms');
      return { streams: streams };
    });
  })
  .catch(function (error) {
    var message = String(error && error.message || error);
    var code = /time budget exceeded/i.test(message) ? 'TIME_BUDGET_EXCEEDED' :
      (/HTTP (401|403)\b/.test(message) ? 'UPSTREAM_AUTH_ERROR' :
      (/HTTP (429)\b/.test(message) ? 'UPSTREAM_RATE_LIMIT' :
      (/HTTP (5\d\d)\b/.test(message) ? 'UPSTREAM_SERVER_ERROR' :
      (/HTTP (4\d\d)\b/.test(message) ? 'UPSTREAM_CLIENT_ERROR' :
      (/network|fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message) ? 'NETWORK_ERROR' :
      (/Invalid JSON/i.test(message) ? 'INVALID_UPSTREAM_JSON' : 'UNEXPECTED_ERROR'))))));
    console.error('[CINEMABOX QUALITY AUDIT]', JSON.stringify({
      stage: failureStage,
      status: 'error',
      errorCode: code,
      rawVideos: null,
      validUniqueStreams: 0,
      qualities: [],
      has2160p: null
    }));
    diagnostic(failureStage, code, type, id, error);
    if (throwOnError) throw error;
    return { streams: [] };
  });
}

// Internet Archive adapter: only explicit Public Domain / CC0 records are eligible.
function normalize(value) {
  return String(value || '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function yearOf(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function isPermittedLicense(metadata) {
  const license = String(metadata && (metadata.licenseurl || metadata.license_url) || '').toLowerCase();
  const rights = String(metadata && metadata.rights || '').toLowerCase();
  return /creativecommons\.org\/publicdomain\/(?:mark|zero)\/1\.0/.test(license) ||
    /public domain/.test(rights);
}

function qualityOf(filename) {
  const match = String(filename || '').match(/(?:^|[._\s-])(2160|1440|1080|720|480|360)p(?:[._\s-]|$)/i);
  return match ? match[1] + 'p' : 'Video';
}

function createInternetArchiveProvider(options) {
  const config = options || {};
  const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch : null);
  const maxResults = Math.max(1, Math.min(5, Number(config.maxResults) || 3));
  const logger = config.console || console;

  function trace(stage, details) {
    const payload = Object.assign({ stage: stage, provider: 'internet-archive' }, details || {});
    const message = '[INTERNET ARCHIVE DIAGNOSTIC] ' + JSON.stringify(payload);
    // Nuvio may suppress plugin console.log output; warning-level messages are
    // surfaced by its runtime logger while remaining non-fatal diagnostics.
    if (logger && typeof logger.warn === 'function') logger.warn(message);
    else if (logger && typeof logger.log === 'function') logger.log(message);
  }

  async function getJson(url) {
    if (!fetchImpl) throw new Error('Internet Archive fetch is unavailable');
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response || !response.ok) throw new Error('Internet Archive HTTP ' + (response && response.status || 'error'));
    return response.json ? response.json() : JSON.parse(await response.text());
  }

  async function getStreams(context) {
    const startedAt = Date.now();
    const input = context || {};
    if (String(input.type || '').toLowerCase() !== 'movie') {
      trace('skipped', { reason: 'unsupported-media-type', mediaType: String(input.type || 'unknown') });
      return [];
    }
    const meta = input.meta || {};
    const title = String(meta.name || meta.title || meta.original_name || '').trim();
    if (!title) {
      trace('skipped', { reason: 'missing-title' });
      return [];
    }

    const year = yearOf(meta.year || meta.release_date);
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const query = 'mediatype:movies AND title:"' + escapedTitle + '"';
    const searchUrl = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(query) +
      '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=licenseurl&rows=' + maxResults + '&page=1&output=json';
    let search;
    try {
      trace('search-start', { year: year || null, maxResults: maxResults });
      search = await getJson(searchUrl);
    } catch (error) {
      trace('error', { stage: 'search', elapsedMs: Date.now() - startedAt, message: String(error && error.message || error) });
      throw error;
    }
    const docs = search && search.response && Array.isArray(search.response.docs)
      ? search.response.docs : [];
    const filtered = { missingIdentifier: 0, titleMismatch: 0, yearMismatch: 0 };
    const candidates = [];
    docs.forEach(function (doc) {
      if (!doc || !doc.identifier) { filtered.missingIdentifier += 1; return; }
      if (normalize(doc.title) !== normalize(title)) { filtered.titleMismatch += 1; return; }
      const candidateYear = yearOf(doc.year);
      if (year && candidateYear && year !== candidateYear) { filtered.yearMismatch += 1; return; }
      candidates.push(doc);
    });
    const selectedCandidates = candidates.slice(0, maxResults);
    trace('search-complete', {
      rawResults: docs.length,
      candidates: selectedCandidates.length,
      filtered: filtered
    });

    const streams = [];
    const rejected = {
      metadataUnavailable: 0,
      licenseNotPermitted: 0,
      metadataTitleMismatch: 0,
      metadataYearMismatch: 0,
      noFiles: 0,
      invalidFileName: 0,
      unsupportedMedia: 0,
      privateOrMetadataFile: 0,
      invalidFileSize: 0
    };
    let metadataRecords = 0;
    let filesInspected = 0;
    let playableFiles = 0;
    for (const doc of selectedCandidates) {
      const metadataUrl = 'https://archive.org/metadata/' + encodeURIComponent(doc.identifier);
      let record;
      try {
        record = await getJson(metadataUrl);
        metadataRecords += 1;
      } catch (error) {
        rejected.metadataUnavailable += 1;
        trace('metadata-error', {
          recordsFetched: metadataRecords,
          message: String(error && error.message || error)
        });
        continue;
      }
      const metadata = record && record.metadata || {};
      if (!isPermittedLicense(metadata)) { rejected.licenseNotPermitted += 1; continue; }
      if (normalize(metadata.title || doc.title) !== normalize(title)) { rejected.metadataTitleMismatch += 1; continue; }
      const recordYear = yearOf(metadata.year || metadata.date || doc.year);
      if (year && recordYear && year !== recordYear) { rejected.metadataYearMismatch += 1; continue; }

      const files = Array.isArray(record.files) ? record.files : [];
      if (!files.length) rejected.noFiles += 1;
      filesInspected += files.length;
      const eligible = [];
      files.forEach(function (file) {
        if (!file || typeof file.name !== 'string' || /[\\/]/.test(file.name) || file.name.indexOf('..') !== -1) {
          rejected.invalidFileName += 1;
          return;
        }
        if (!/\.(?:mp4|m4v|webm|ogv)$/i.test(file.name)) {
          rejected.unsupportedMedia += 1;
          return;
        }
        if (file.source === 'metadata' || file.private === true || file.private === 'true') {
          rejected.privateOrMetadataFile += 1;
          return;
        }
        if (!(Number(file.size) > 0)) {
          rejected.invalidFileSize += 1;
          return;
        }
        eligible.push(file);
      });
      const playable = eligible.sort(function (a, b) {
        return Number(b.size || 0) - Number(a.size || 0);
      }).slice(0, 3);
      playableFiles += playable.length;
      playable.forEach(function (file) {
        const quality = qualityOf(file.name);
        const url = 'https://archive.org/download/' + encodeURIComponent(doc.identifier) + '/' + encodeURIComponent(file.name);
        streams.push({
          name: 'Internet Archive (' + title + ') ' + quality,
          title: 'Internet Archive (' + title + ') ' + quality,
          url: url,
          quality: quality
        });
      });
      if (streams.length >= 3) break;
    }
    const result = streams.slice(0, 3);
    trace('complete', {
      rawResults: docs.length,
      candidates: selectedCandidates.length,
      metadataRecords: metadataRecords,
      filesInspected: filesInspected,
      playableFiles: playableFiles,
      streams: result.length,
      rejected: rejected,
      elapsedMs: Date.now() - startedAt
    });
    return result;
  }

  return {
    id: 'internet-archive',
    name: 'Internet Archive',
    supports: function (context) {
      return String(context && context.type || '').toLowerCase() === 'movie';
    },
    getStreams: getStreams
  };
}


var ENABLE_INTERNET_ARCHIVE_PROVIDER = true;

var cinemaBoxProviderEngine = createProviderEngine({
  providers: [{
    id: 'cinemabox',
    name: 'CinemaBox',
    priority: 100,
    // Nuvio's embedded timer implementation can retain completed timers.
    // fetchStreams enforces the shared deadline before each network stage.
    skipTimeoutTimer: true,
    getStreams: function (context) {
      var adapterStartedAt = Date.now();
      console.log('[ENGINE TRACE] adapter-start', 'at:', adapterStartedAt);
      return fetchStreams(context.type, context.id, context.meta, context.deadline, true)
        .then(function (result) {
          console.log('[ENGINE TRACE] adapter-finish', 'elapsedMs:', Date.now() - adapterStartedAt, 'streams:', Array.isArray(result && result.streams) ? result.streams.length : 0);
          return Array.isArray(result && result.streams) ? result.streams : [];
        });
    }
  }, Object.assign(createInternetArchiveProvider(), {
    priority: 50,
    timeoutMs: 5000,
    fallbackOnlyWhenEmpty: true,
    enabled: ENABLE_INTERNET_ARCHIVE_PROVIDER
  })],
  maxConcurrency: 2,
  providerTimeoutMs: PROVIDER_BUDGET_MS,
  failureThreshold: 3,
  cooldownMs: 10000
});

function getTmdbMetadata(tmdbId, mediaType, deadline) {
  var kind = (String(mediaType).toLowerCase() === 'tv' || String(mediaType).toLowerCase() === 'series') ? 'tv' : 'movie';
  var key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';
  if (!key) return Promise.reject(new Error('TMDB API key is unavailable'));

  var url = 'https://api.themoviedb.org/3/' + kind + '/' +
    encodeURIComponent(String(tmdbId)) + '?api_key=' + encodeURIComponent(key) +
    '&append_to_response=external_ids';

  return cached('tmdb-meta-' + kind + '-' + tmdbId, function () {
    return requestWithRetry(url, deadline, 1).then(function (data) {
      var imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
      var name = data.title || data.name;
      if (!imdbId || !name) throw new Error('TMDB metadata is incomplete for ' + tmdbId);

      return {
        imdbId: imdbId,
        meta: {
          name: name,
          original_name: data.original_title || data.original_name || name,
          year: data.release_date || data.first_air_date || ''
        }
      };
    });
  }, METADATA_CACHE_TTL_MS);
}
function getStreamsForNuvio(input, mediaType, season, episode) {
  var requestStart = Date.now();
  var deadline = requestStart + PROVIDER_BUDGET_MS;
  return Promise.resolve().then(function () {
    var args = input && typeof input === 'object'
      ? input
      : { tmdbId: input, mediaType: mediaType, season: season, episode: episode };

    var rawType = String(args.mediaType || 'movie').toLowerCase();
    var oldType = rawType === 'tv' ? 'series' : rawType;
    var rawId = String(args.tmdbId || '').replace(/^imdb:/i, '');
    // Error-level marker makes plugin invocation distinguishable from player-only logs.
    console.error('[CINEMABOX RUNTIME]', JSON.stringify({
      stage: 'start',
      mediaType: rawType,
      id: rawId || 'unknown',
      season: args.season == null ? null : Number(args.season),
      episode: args.episode == null ? null : Number(args.episode)
    }));

    // لا تنفذ أي طلب metadata لمسلسل قبل تحديد حلقة صالحة.
    // Nuvio قد يرسل -1:-1 عند فتح صفحة المسلسل دون اختيار حلقة.
    if (oldType === 'series') {
      var requestedSeason = Number(args.season);
      var requestedEpisode = Number(args.episode);
      if (!Number.isInteger(requestedSeason) || requestedSeason < 0 ||
          !Number.isInteger(requestedEpisode) || requestedEpisode < 1) {
        console.log('[SKIP STREAMS]', 'reason: episode-not-selected',
          'season:', args.season, 'episode:', args.episode);
        return [];
      }
    }

    function run(imdbId, meta) {
      if (!imdbId) return [];
      var id = imdbId;
      if (oldType === 'series') {
        if (args.season == null || args.episode == null) return [];
        id += ':' + Number(args.season) + ':' + Number(args.episode);
      }
      return cinemaBoxProviderEngine.getStreams({
        type: oldType,
        id: id,
        meta: meta,
        deadline: deadline
      }).then(function (result) {
        console.log('[ENGINE TRACE] entry-engine-result', 'elapsedMs:', Date.now() - requestStart, 'at:', Date.now());
        var streams = result.streams.map(function (stream) {
          // Preserve the exact public stream shape expected by Nuvio.
          return {
            name: stream.name,
            title: stream.title,
            url: stream.url,
            quality: stream.quality
          };
        });
        var providerHealth = cinemaBoxProviderEngine.getHealth();
        console.log('[PROVIDER ENGINE]', JSON.stringify({
          providers: result.providers.map(function (provider) {
            var health = providerHealth[provider.providerId] || {};
            return {
              id: provider.providerId,
              status: provider.status,
              streams: provider.streams.length,
              rawStreams: provider.rawStreams == null ? 0 : provider.rawStreams,
              rejectedStreams: provider.rejectedStreams == null ? 0 : provider.rejectedStreams,
              rejectionReasons: provider.rejectionReasons || {},
              elapsedMs: provider.elapsedMs == null ? null : provider.elapsedMs,
              attempts: health.attempts == null ? 0 : health.attempts,
              successes: health.successes == null ? 0 : health.successes,
              productiveRate: health.productiveRate,
              emptyResponses: health.emptyResponses == null ? 0 : health.emptyResponses,
              errorCount: health.errorCount == null ? 0 : health.errorCount,
              timeoutCount: health.timeoutCount == null ? 0 : health.timeoutCount,
              rejectedStreams: health.rejectedStreams == null ? 0 : health.rejectedStreams,
              validStreams: health.validStreams == null ? 0 : health.validStreams,
              latencyEwmaMs: health.latencyEwmaMs,
              lastStatus: health.lastStatus || provider.status,
              circuitOpen: health.circuitOpen === true,
              retryAt: health.retryAt
            };
          }),
          totalStreams: streams.length
        }));
        console.log('[TIMING] getStreams total:', Date.now() - requestStart, 'ms');
        return streams;
      });
    }

    if (/^tt\d+$/i.test(rawId)) {
      return getExternalMeta(oldType, rawId, deadline).then(function (meta) {
        return run(rawId, meta);
      });
    }

    var tmdbStart = Date.now();
    ensureBudget(deadline, 'TMDB metadata');
    return getTmdbMetadata(rawId, rawType, deadline).then(function (resolved) {
      console.log('[TIMING] TMDB metadata:', Date.now() - tmdbStart, 'ms');
      return run(resolved.imdbId, resolved.meta);
    }).catch(function (error) {
      var message = String(error && error.message || error);
      var code = /time budget exceeded/i.test(message) ? 'TIME_BUDGET_EXCEEDED' :
        (/HTTP (401|403)\b/.test(message) ? 'UPSTREAM_AUTH_ERROR' :
        (/HTTP 429\b/.test(message) ? 'UPSTREAM_RATE_LIMIT' :
        (/HTTP 5\d\d\b/.test(message) ? 'UPSTREAM_SERVER_ERROR' :
        (/HTTP 4\d\d\b/.test(message) ? 'UPSTREAM_CLIENT_ERROR' :
        (/network|fetch failed|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message) ? 'NETWORK_ERROR' :
        (/Invalid JSON/i.test(message) ? 'INVALID_UPSTREAM_JSON' : 'UNEXPECTED_ERROR'))))));
      diagnostic('tmdb_metadata', code, rawType, rawId, error);
      return [];
    });
  }).catch(function (error) {
    diagnostic('entry', 'UNEXPECTED_ERROR', 'unknown', 'unknown', error);
    return [];
  });
}

module.exports = { getStreams: getStreamsForNuvio };
