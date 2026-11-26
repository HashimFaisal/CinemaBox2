'use strict';

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
const SEARCH_MAX_PAGES = 5;

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
    cache.delete(key);
    cache.set(key, old);
    return old.value;
  }
  if (old) cache.delete(key);

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
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + ': ' + redactSensitive(url) + ' | BODY: ' + redactSensitive(body.slice(0, 700)));
      }
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new Error('Invalid JSON from ' + redactSensitive(url) + ': ' + redactSensitive(body.slice(0, 300)));
      }
    });
  });
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
    return api('shows/shows/dynamic/' + id + suffix, deadline);
  }, DETAILS_CACHE_TTL_MS);
}

function getPlayer(episodeId, deadline) {
  return cached('player-' + episodeId, function () {
    return api('shows/episodes/player/' + episodeId, deadline);
  }, PLAYER_CACHE_TTL_MS);
}

function getExternalMeta(type, id, deadline) {
  return cached('external-' + type + '-' + id, function () {
    return request(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json', deadline).then(function (data) {
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
        if (best && best.score >= 0.95) {
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
      if (best && best.score >= 0.95) {
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
        if (best && best.score >= 0.95) {
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
  var quality = normalizeQuality(video.quality);
  var streamLabel = 'CinemaBox (' + displayTitle + ') ' + quality;
  return {
    name: streamLabel,
    title: streamLabel,
    url: video.url,
    quality: quality
  };
}

function fetchStreams(type, id, suppliedMeta, deadline) {
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
    return searchCinemaBox(meta.name || meta.original_name, type, year, deadline).catch(function (error) {
      // A network failure on the primary title must not suppress a distinct original-title search.
      if (meta.original_name && normalizeTitle(meta.original_name) !== normalizeTitle(meta.name)) {
        console.log('[SEARCH FALLBACK]', 'reason: primary-search-error', redactSensitive(error && error.message || error));
        ensureBudget(deadline, 'original title fallback after search error');
        return searchCinemaBox(meta.original_name, type, year, deadline);
      }
      throw error;
    }).then(function (found) {
      console.log('[TIMING] search:', Date.now() - stageStart, 'ms');
      stageStart = Date.now();
      if (found) return found;
      if (meta.original_name && normalizeTitle(meta.original_name) !== normalizeTitle(meta.name)) {
        console.log('[RETRY WITH ARABIC]', meta.original_name);
        ensureBudget(deadline, 'original title fallback');
        return searchCinemaBox(meta.original_name, type, year, deadline);
      }
      return null;
    });
  })
  .then(function (found) {
    if (!found) {
      diagnostic('search', 'TITLE_NOT_FOUND', type, id);
      return null;
    }
    failureStage = 'details';
    ensureBudget(deadline, 'show details');
    return getDetails(found.id, null, deadline).then(function (details) {
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
    return getPlayer(episodeId, deadline).then(function (player) {
      console.log('[TIMING] player:', Date.now() - stageStart, 'ms');
      var streams = [];
      if (!player || !Array.isArray(player.videos)) {
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
        return /^2160p(?:\\b|$)/i.test(String(quality).trim());
      });
      console.log('[CINEMABOX QUALITY AUDIT]', JSON.stringify({
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
    diagnostic(failureStage, code, type, id, error);
    return { streams: [] };
  });
}

function getTmdbMetadata(tmdbId, mediaType, deadline) {
  var kind = (String(mediaType).toLowerCase() === 'tv' || String(mediaType).toLowerCase() === 'series') ? 'tv' : 'movie';
  var key = typeof TMDB_API_KEY !== 'undefined' ? TMDB_API_KEY : '';
  if (!key) return Promise.reject(new Error('TMDB API key is unavailable'));

  var url = 'https://api.themoviedb.org/3/' + kind + '/' +
    encodeURIComponent(String(tmdbId)) + '?api_key=' + encodeURIComponent(key) +
    '&append_to_response=external_ids';

  return cached('tmdb-meta-' + kind + '-' + tmdbId, function () {
    return request(url, deadline).then(function (data) {
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
      return fetchStreams(oldType, id, meta, deadline).then(function (result) {
        var streams = Array.isArray(result && result.streams) ? result.streams : [];
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
