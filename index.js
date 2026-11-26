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
const PROVIDER_BUDGET_MS = 45000;
const SEARCH_MAX_PAGES = 5;

function ensureBudget(deadline, stage) {
  if (deadline && Date.now() >= deadline) {
    throw new Error('CinemaBox time budget exceeded before ' + stage);
  }
}

function cached(key, loader, ttl) {
  if (ttl == null) ttl = 120000;
  const old = cache.get(key);
  if (old && Date.now() - old.time < ttl) {
    // Refresh insertion order so frequently used entries stay in the LRU window.
    cache.delete(key);
    cache.set(key, old);
    return old.value;
  }
  if (old) cache.delete(key);

  const value = Promise.resolve().then(loader).catch(function (error) {
    var current = cache.get(key);
    if (current && current.value === value) cache.delete(key);
    throw error;
  });

  cache.set(key, { time: Date.now(), value: value });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}

function uniqueStreamVideos(videos) {
  var seen = new Set();
  return (Array.isArray(videos) ? videos : []).filter(function (video) {
    if (!video || typeof video.url !== 'string' || !/^https?:\/\//i.test(video.url)) return false;
    if (seen.has(video.url)) return false;
    seen.add(video.url);
    return true;
  });
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
  });
}

function getPlayer(episodeId, deadline) {
  return cached('player-' + episodeId, function () {
    return api('shows/episodes/player/' + episodeId, deadline);
  }, 30000);
}

function getExternalMeta(type, id, deadline) {
  return cached('external-' + type + '-' + id, function () {
    return request(CINEMETA + '/meta/' + type + '/' + encodeURIComponent(id) + '.json', deadline).then(function (data) {
      if (!data.meta || !data.meta.name) throw new Error('No external metadata for ' + id);
      return data.meta;
    });
  }, 600000);
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
  }, 600000);
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
  var currentSeason = Number((details.post_info && details.post_info.season_number) || 1);
  var seasonPromise = Promise.resolve(seasonDetails);

  console.log('[SEASON RESOLVE]', 'requested:', seasonNumber,
    'current:', currentSeason, 'requiresSeasonFetch:', seasonNumber !== currentSeason);

  if (seasonNumber !== currentSeason) {
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
      var match = String(seasonCards[i].title || '').match(/\d+/);
      if (match && Number(match[0]) === seasonNumber) {
        seasonCard = seasonCards[i];
        break;
      }
    }

    if (!seasonCard) {
      console.log('[SEASON NOT AVAILABLE]', 'requested:', seasonNumber);
      return Promise.resolve(null);
    }

    var seasonLoadStart = Date.now();
    ensureBudget(deadline, 'season details');
    seasonPromise = getDetails(showId, seasonCard.id, deadline).then(function (loaded) {
      console.log('[TIMING] season details:', Date.now() - seasonLoadStart,
        'ms', 'season:', seasonNumber, 'seasonId:', seasonCard.id);
      var loadedSeason = Number((loaded.post_info && loaded.post_info.season_number) || 0);
      if (loadedSeason !== seasonNumber) {
        console.log('[SEASON LOAD MISMATCH]', 'requested:', seasonNumber, 'loaded:', loadedSeason);
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

    for (var idx = 0; idx < episodes.length; idx++) {
      var parsed = Number(episodes[idx].description);
      var number = (Number.isFinite(parsed) && parsed > 0) ? parsed : idx + 1;
      if (number === episodeNumber) return episodes[idx].id;
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
  var quality = video.quality || 'Video';
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
  var external = parseExternalId(id);

  if (!external) {
    console.log('[UNSUPPORTED ID]', type, id);
    return Promise.resolve({ streams: [] });
  }

  var metaPromise = suppliedMeta
    ? Promise.resolve(suppliedMeta)
    : getExternalMeta(type, external.imdbId, deadline);

  return metaPromise.then(function (meta) {
    displayTitle = String(meta.name || meta.original_name || external.imdbId);
    if (type === 'series' && external.season && external.episode) {
      var seasonLabel = String(external.season).padStart(2, '0');
      var episodeLabel = String(external.episode).padStart(2, '0');
      displayTitle += ' S' + seasonLabel + 'E' + episodeLabel;
    }
    console.log('[TIMING] metadata:', Date.now() - stageStart, 'ms');
    stageStart = Date.now();
    var year = releaseYear(meta.year);
    
    ensureBudget(deadline, 'primary title search');
    return searchCinemaBox(meta.name, type, year, deadline).then(function (found) {
      console.log('[TIMING] search:', Date.now() - stageStart, 'ms');
      stageStart = Date.now();
      if (found) return found;
      if (meta.original_name && meta.original_name !== meta.name) {
        console.log('[RETRY WITH ARABIC]', meta.original_name);
        ensureBudget(deadline, 'original title fallback');
        return searchCinemaBox(meta.original_name, type, year, deadline);
      }
      return null;
    }).catch(function (error) {
      // A network failure on the primary title must not suppress a distinct original-title search.
      if (meta.original_name && normalizeTitle(meta.original_name) !== normalizeTitle(meta.name)) {
        console.log('[SEARCH FALLBACK]', 'reason: primary-search-error', redactSensitive(error && error.message || error));
        ensureBudget(deadline, 'original title fallback after search error');
        return searchCinemaBox(meta.original_name, type, year, deadline);
      }
      throw error;
    });
  })
  .then(function (found) {
    if (!found) return null;
    ensureBudget(deadline, 'show details');
    return getDetails(found.id, null, deadline).then(function (details) {
      console.log('[TIMING] details:', Date.now() - stageStart, 'ms');
      stageStart = Date.now();
      var post = details.post_info;
      if (!post) return null;

      if (type === 'movie') {
        episodeId = post.episode_id;
        return episodeId;
      }

      if (!external.season || !external.episode) return null;
      return findEpisode(details, found.id, external.season, external.episode, deadline);
    });
  })
  .then(function (resolvedEpisodeId) {
    episodeId = resolvedEpisodeId;
    if (!episodeId) {
      console.log('[NO EPISODE ID]', type, id);
      return { streams: [] };
    }

    ensureBudget(deadline, 'player lookup');
    return getPlayer(episodeId, deadline).then(function (player) {
      console.log('[TIMING] player:', Date.now() - stageStart, 'ms');
      var streams = [];
      var playerVideos = Array.isArray(player && player.videos) ? player.videos : [];
      console.log('[PLAYER DIAGNOSTICS]', type, id,
        'playerKeys:', Object.keys(player || {}),
        'videosType:', Array.isArray(player && player.videos) ? 'array' : typeof (player && player.videos),
        'videosCount:', playerVideos.length);
      playerVideos.forEach(function (video, index) {
        var videoUrl = video && video.url;
        var validUrl = typeof videoUrl === 'string' && /^https?:\/\//i.test(videoUrl);
        console.log('[PLAYER VIDEO]', 'index:', index,
          'keys:', Object.keys(video || {}),
          'urlType:', typeof videoUrl,
          'validHttpUrl:', validUrl,
          'quality:', video && video.quality ? video.quality : 'unknown');
      });
      uniqueStreamVideos(playerVideos).forEach(function (video) {
        streams.push(buildStream(video, displayTitle));
      });
      console.log('[STREAMS]', type, id, 'episode:', episodeId,
        'rawVideos:', playerVideos.length, 'uniqueValid:', streams.length,
        'total:', Date.now() - timingStart, 'ms');
      return { streams: streams };
    });
  })
  .catch(function (error) {
    console.error('[STREAM ERROR]', type, id, error.message);
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
  }, 600000);
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
      if (!Number.isInteger(requestedSeason) || requestedSeason < 1 ||
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
      console.error('[TMDB METADATA]', rawId, error.message);
      return [];
    });
  }).catch(function (error) {
    console.error('[CINEMA BOX NUVIO]', error);
    return [];
  });
}

module.exports = { getStreams: getStreamsForNuvio };
