'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function loadInternals(fetchImpl, logger) {
  const sandbox = {
    URL,
    setTimeout,
    clearTimeout,
    module: { exports: {} },
    fetch: fetchImpl,
    TMDB_API_KEY: 'test-secret-key',
    console: logger || { log() {}, error() {} }
  };
  vm.runInNewContext(
    source + '\nmodule.exports.__test = { redactSensitive, cached, searchCinemaBox, searchCinemaBoxTitles, cache, CACHE_MAX_ENTRIES, DETAILS_CACHE_TTL_MS, PLAYER_CACHE_TTL_MS, SEARCH_CACHE_TTL_MS, METADATA_CACHE_TTL_MS, uniqueStreamVideos, validateStreamUrl, normalizeQuality, normalizeTitle, titleScore, findEpisode, buildStream, fetchStreams, ensureBudget, request, requestWithRetry, getPlayer, getStreamsForNuvio };',
    sandbox,
    { filename: 'index.js' }
  );
  return sandbox.module.exports.__test;
}

test('HTTP timing diagnostics report endpoint and duration without query secrets', async () => {
  const logs = [];
  const api = loadInternals(() => Promise.resolve({
    status: 200,
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ ok: true }))
  }), { log(...args) { logs.push(args.join(' ')); }, error() {} });

  const result = await api.request(
    'https://api.example.test/items?api_key=test-secret-key&term=private-title'
  );

  assert.equal(result.ok, true);
  const timing = logs.find(line => line.includes('[HTTP TIMING]'));
  assert.ok(timing, 'expected one HTTP timing record');
  assert.match(timing, /api\.example\.test\/items/);
  assert.match(timing, /status: 200/);
  assert.match(timing, /ms:/);
  assert.equal(timing.includes('test-secret-key'), false);
  assert.equal(timing.includes('private-title'), false);
});

test('request diagnostics redact TMDB API keys in URLs and response text', () => {
  const api = loadInternals(() => {});
  const result = api.redactSensitive(
    'https://api.example.test/item?api_key=test-secret-key&lang=en body=test-secret-key'
  );
  assert.equal(
    result,
    'https://api.example.test/item?api_key=[REDACTED]&lang=en body=[REDACTED]'
  );
});

test('rejected cache loaders are evicted and can be retried', async () => {
  const api = loadInternals(() => {});
  let calls = 0;
  await assert.rejects(api.cached('retry-me', () => {
    calls++;
    throw new Error('temporary failure');
  }, 600000));
  const value = await api.cached('retry-me', () => {
    calls++;
    return 'recovered';
  }, 600000);
  assert.equal(value, 'recovered');
  assert.equal(calls, 2);
});

test('failed search pages reject instead of becoming a cached no-result', async () => {
  let calls = 0;
  const api = loadInternals(() => {
    calls++;
    return Promise.reject(new Error('network unavailable'));
  });

  await assert.rejects(api.searchCinemaBox('The Matrix', 'movie'));
  await assert.rejects(api.searchCinemaBox('The Matrix', 'movie'));
  assert.equal(calls, 4, 'each search should retry its failed first-page request');
});

test('a genuine empty search result remains a valid cacheable no-result', async () => {
  let calls = 0;
  const api = loadInternals(() => {
    calls++;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ results: [] }))
    });
  });

  const first = await api.searchCinemaBox('No Such Film', 'movie');
  const second = await api.searchCinemaBox('No Such Film', 'movie');
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 1, 'a successful empty response should be cached');
});


test('cache stays bounded and refreshes recently used entries', async () => {
  const api = loadInternals(() => {});
  await api.cached('oldest', () => 'old', 600000);
  for (let index = 0; index < api.CACHE_MAX_ENTRIES - 1; index++) {
    await api.cached('entry-' + index, () => index, 600000);
  }
  await api.cached('oldest', () => 'should-not-run', 600000);
  await api.cached('overflow', () => 'new', 600000);

  assert.equal(api.cache.size, api.CACHE_MAX_ENTRIES);
  assert.equal(api.cache.has('oldest'), true, 'recently used entry should remain');
  assert.equal(api.cache.has('entry-0'), false, 'least recently used entry should be evicted');
});

test('stream URL deduplication preserves first occurrence and rejects invalid URLs', () => {
  const api = loadInternals(() => {});
  const urls = api.uniqueStreamVideos([
    { url: 'https://cdn.example/1080p.m3u8', quality: '1080p' },
    { url: 'https://cdn.example/720p.m3u8', quality: '720p' },
    { url: 'https://cdn.example/1080p.m3u8', quality: 'duplicate' },
    { url: 'javascript:alert(1)', quality: 'invalid' },
    { url: 'https://cdn.example/720p.m3u8', quality: 'duplicate' }
  ]).map(video => video.url).join('|');

  assert.equal(urls, 'https://cdn.example/1080p.m3u8|https://cdn.example/720p.m3u8');
});


test('concurrent cache requests share one in-flight loader and TTL starts after completion', async () => {
  const api = loadInternals(() => {});
  let calls = 0;
  const loader = () => new Promise(resolve => {
    calls++;
    setTimeout(() => resolve('cached-result'), 40);
  });

  const first = api.cached('shared-key', loader, 25);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = api.cached('shared-key', loader, 25);
  assert.equal(await first, 'cached-result');
  assert.equal(await second, 'cached-result');
  assert.equal(calls, 1, 'overlapping requests must share one loader');

  const withinTtl = await api.cached('shared-key', () => {
    calls++;
    return 'unexpected';
  }, 25);
  assert.equal(withinTtl, 'cached-result', 'TTL must begin after the slow loader completes');
  assert.equal(calls, 1);

  await new Promise(resolve => setTimeout(resolve, 35));
  const afterExpiry = await api.cached('shared-key', () => {
    calls++;
    return 'refreshed-result';
  }, 25);
  assert.equal(afterExpiry, 'refreshed-result');
  assert.equal(calls, 2, 'expired values should be refreshed');
});

test('cache uses separate lifetimes for details, player links, search and metadata', () => {
  const api = loadInternals(() => {});
  assert.equal(api.DETAILS_CACHE_TTL_MS, 300000);
  assert.equal(api.PLAYER_CACHE_TTL_MS, 30000);
  assert.equal(api.SEARCH_CACHE_TTL_MS, 600000);
  assert.equal(api.METADATA_CACHE_TTL_MS, 600000);
});


test('Arabic title normalization ignores diacritics and tatweel', () => {
  const api = loadInternals(() => {});
  assert.equal(api.normalizeTitle('الْمَاتْرِكْس'), api.normalizeTitle('الماتركس'));
  assert.equal(api.titleScore('الْمَاتْرِكْس', 'الماتركس'), 1);
  assert.equal(api.normalizeTitle('مــاتريكس'), api.normalizeTitle('ماتريكس'));
});


test('stream objects expose quality as a separate Nuvio field and reject invalid URLs', () => {
  const api = loadInternals(() => {});
  assert.equal(api.buildStream({ url: '', quality: '1080p' }, 'Invalid stream'), null);
  assert.equal(api.buildStream({ url: 'https:///missing-host.mp4', quality: '1080p' }, 'Invalid stream'), null);
  const stream = api.buildStream({
    url: 'https://cdn.example/1080p.mp4',
    quality: '1080p'
  }, 'The Flash S02E05');

  assert.equal(stream.quality, '1080p');
  assert.match(stream.name, /1080p/);
  assert.match(stream.title, /1080p/);
  assert.equal(stream.url, 'https://cdn.example/1080p.mp4');
});

test('episode lookup fetches season details only when requested season differs', async () => {
  const requests = [];
  const api = loadInternals((url) => {
    requests.push(url);
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        post_info: { season_number: 2 },
        sections: [{
          section_type: 'episodes',
          data: [{ id: 'episode-201', card_type: 'episode', description: '1' }]
        }]
      }))
    });
  });

  const showDetails = {
    post_info: { season_number: 1 },
    sections: [{
      data: [{ id: 'season-2-id', card_type: 'seasonposter', title: 'Season 2' }]
    }]
  };

  const seasonOneEpisode = await api.findEpisode(showDetails, 'show-123', 1, 1);
  assert.equal(seasonOneEpisode, null);
  assert.equal(requests.length, 0, 'current season should reuse the initial details response');

  const seasonTwoEpisode = await api.findEpisode(showDetails, 'show-123', 2, 1);
  assert.equal(seasonTwoEpisode, 'episode-201');
  assert.equal(requests.length, 1, 'a different season should trigger exactly one details request');
  assert.match(requests[0], /season_id=season-2-id/);
});


test('provider budget guard stops starting new work after the deadline', () => {
  const api = loadInternals(() => {});
  assert.throws(
    () => api.ensureBudget(Date.now() - 1, 'test stage'),
    /time budget exceeded before test stage/
  );
  assert.equal(api.ensureBudget(Date.now() + 1000, 'test stage'), undefined);
});

test('primary title network failure falls back to original title', async () => {
  const requests = [];
  const api = loadInternals((url) => {
    requests.push(url);
    if (url.includes('/search?') && url.includes('term=Primary')) {
      return Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve('temporary upstream error')
      });
    }
    if (url.includes('/search?') && url.includes('term=Original')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 42, title: 'Original', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/42')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ post_info: { episode_id: 99 } }))
      });
    }
    if (url.includes('/shows/episodes/player/99')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          videos: [{ url: 'https://cdn.example/original.mp4', quality: '1080p' }]
        }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const result = await api.fetchStreams('movie', 'tt1234567', {
    name: 'Primary',
    original_name: 'Original',
    year: ''
  });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].quality, '1080p');
  assert.ok(requests.some(url => url.includes('term=Primary')));
  assert.ok(requests.some(url => url.includes('term=Original')));
});

test('permanent HTTP search errors are not retried', async () => {
  let calls = 0;
  const api = loadInternals(() => {
    calls++;
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('not found')
    });
  });

  await assert.rejects(api.searchCinemaBox('Missing', 'movie'));
  assert.equal(calls, 1, 'a permanent 404 should not be retried');
});


test('successful empty primary search uses original title only once', async () => {
  let originalCalls = 0;
  const api = loadInternals((url) => {
    if (url.includes('term=Primary')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ results: [] }))
      });
    }
    if (url.includes('term=Original')) {
      originalCalls++;
      return Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve('temporarily unavailable')
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const result = await api.fetchStreams('movie', 'tt7654321', {
    name: 'Primary',
    original_name: 'Original',
    year: ''
  });

  assert.deepEqual(Array.from(result.streams), []);
  assert.equal(originalCalls, 2, 'one original-title search with one transient retry is expected');
});

test('missing initial season metadata forces an explicit season fetch', async () => {
  const requests = [];
  const api = loadInternals((url) => {
    requests.push(url);
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        post_info: { season_number: 3 },
        sections: [{
          section_type: 'episodes',
          data: [{ id: 'episode-301', card_type: 'episode', description: '1' }]
        }]
      }))
    });
  });

  const initialDetails = {
    post_info: {},
    sections: [{
      data: [{ id: 'season-3-id', card_type: 'seasonposter', title: 'Season 3' }]
    }]
  };

  const episodeId = await api.findEpisode(initialDetails, 'show-123', 3, 1);
  assert.equal(episodeId, 'episode-301');
  assert.equal(requests.length, 1, 'unknown initial season must not be assumed to be season 1');
  assert.match(requests[0], /season_id=season-3-id/);
});

test('mixed numbered and unnumbered episode cards never use positional fallback', async () => {
  const api = loadInternals(() => { throw new Error('unexpected season fetch'); });
  const details = {
    post_info: { season_number: 1 },
    sections: [{
      section_type: 'episodes',
      data: [
        { id: 'episode-1', card_type: 'episode', description: 'Episode 1' },
        { id: 'unknown-episode', card_type: 'episode', description: '' },
        { id: 'episode-3', card_type: 'episode', description: '3' }
      ]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-123', 1, 2), null);
  assert.equal(await api.findEpisode(details, 'show-123', 1, 3), 'episode-3');
});

test('stream validation rejects incomplete and malformed HTTP URLs', () => {
  const api = loadInternals(() => {});
  const videos = api.uniqueStreamVideos([
    { url: 'https://' },
    { url: 'http://' },
    { url: 'https:///missing-host.mp4' },
    { url: 'https://cdn.example/video file.mp4' },
    { url: 'https://cdn.example\\\\video.mp4' },
    { url: 'https://cdn.example/video.mp4' }
  ]);
  assert.deepEqual(Array.from(videos, video => video.url), [
    'https://cdn.example/video.mp4'
  ]);
});

test('stream deduplication preserves distinct signed query strings', () => {
  const api = loadInternals(() => {});
  const videos = api.uniqueStreamVideos([
    { url: 'https://cdn.example/video.mp4?token=one' },
    { url: 'https://cdn.example/video.mp4?token=two' },
    { url: 'https://cdn.example/video.mp4?token=one' }
  ]);
  assert.deepEqual(Array.from(videos, video => video.url), [
    'https://cdn.example/video.mp4?token=one',
    'https://cdn.example/video.mp4?token=two'
  ]);
});


test('request rejects a successful HTTP response containing malformed JSON', async () => {
  const api = loadInternals(() => Promise.resolve({
    ok: true,
    text: () => Promise.resolve('{"videos":')
  }));

  await assert.rejects(
    api.request('https://cinema.albox.co/api/v4/test'),
    /Invalid JSON from/
  );
});

test('request rejects an empty successful HTTP response instead of treating it as empty data', async () => {
  const api = loadInternals(() => Promise.resolve({
    ok: true,
    text: () => Promise.resolve('')
  }));

  await assert.rejects(
    api.request('https://cinema.albox.co/api/v4/test'),
    /Invalid JSON from/
  );
});

test('player endpoint rejects malformed JSON and evicts the failed cache entry', async () => {
  let calls = 0;
  const api = loadInternals(() => {
    calls++;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve('{not-json')
    });
  });

  await assert.rejects(api.getPlayer('player-malformed'));
  await assert.rejects(api.getPlayer('player-malformed'));
  assert.equal(calls, 2, 'failed player responses must not remain cached');
});

test('movie lookup returns no streams when details payload lacks post_info', async () => {
  const api = loadInternals((url) => {
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 901, title: 'Malformed Details Movie', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/901')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ sections: [] }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const result = await api.fetchStreams('movie', 'tt9010001', {
    name: 'Malformed Details Movie',
    original_name: 'Malformed Details Movie',
    year: ''
  });

  assert.deepEqual(Array.from(result.streams), []);
});

test('movie lookup returns no streams when player videos field has an unexpected type', async () => {
  const api = loadInternals((url) => {
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 902, title: 'Malformed Player Movie', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/902')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          post_info: { episode_id: 9902 }
        }))
      });
    }
    if (url.includes('/shows/episodes/player/9902')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ videos: 'not-an-array' }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const result = await api.fetchStreams('movie', 'tt9020001', {
    name: 'Malformed Player Movie',
    original_name: 'Malformed Player Movie',
    year: ''
  });

  assert.deepEqual(Array.from(result.streams), []);
});

test('movie lookup safely returns no streams when the player endpoint has a transient network failure', async () => {
  const api = loadInternals((url) => {
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 903, title: 'Player Network Failure Movie', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/903')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          post_info: { episode_id: 9903 }
        }))
      });
    }
    if (url.includes('/shows/episodes/player/9903')) {
      return Promise.reject(new Error('simulated player network failure'));
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const result = await api.fetchStreams('movie', 'tt9030001', {
    name: 'Player Network Failure Movie',
    original_name: 'Player Network Failure Movie',
    year: ''
  });

  assert.deepEqual(Array.from(result.streams), []);
});


test('stream URL validation uses URL parsing and rejects credentials or invalid authorities', () => {
  const api = loadInternals(() => {});
  const valid = [
    'https://cdn.example/video.mp4?token=a%2Fb',
    'http://192.0.2.10:8080/video.m3u8',
    'https://cdn.example/path/master.m3u8'
  ];
  const invalid = [
    'https://',
    'http://',
    'https:///missing-host.mp4',
    'https://user:pass@cdn.example/video.mp4',
    'https://cdn.example:bad/video.mp4',
    'ftp://cdn.example/video.mp4',
    'https://cdn.example/video file.mp4',
    ' https://cdn.example/video.mp4',
    'https://cdn.example\\\\video.mp4'
  ];
  valid.forEach(url => assert.equal(api.validateStreamUrl(url), true, url));
  invalid.forEach(url => assert.equal(api.validateStreamUrl(url), false, url));
});

test('three distinct provider qualities remain three independent Nuvio streams', () => {
  const api = loadInternals(() => {});
  const videos = [
    { url: 'https://cdn.example/movie-1080.mp4?sig=a', quality: '1080P' },
    { url: 'https://cdn.example/movie-720.mp4?sig=b', quality: '720p' },
    { url: 'https://cdn.example/movie-480.mp4?sig=c', quality: '480P' }
  ];
  const streams = api.uniqueStreamVideos(videos).map(video => api.buildStream(video, 'Test Movie'));
  assert.equal(streams.length, 3);
  assert.deepEqual(Array.from(streams, stream => stream.quality), ['1080p', '720p', '480p']);
  assert.deepEqual(Array.from(streams, stream => stream.url), videos.map(video => video.url));
});

test('same endpoint is not counted twice as two qualities and signed URLs stay distinct', () => {
  const api = loadInternals(() => {});
  const videos = api.uniqueStreamVideos([
    { url: 'https://cdn.example/video.mp4?token=one', quality: '1080p' },
    { url: 'https://cdn.example/video.mp4?token=one', quality: '720p' },
    { url: 'https://cdn.example/video.mp4?token=two', quality: '480p' }
  ]);
  assert.equal(videos.length, 2);
  assert.deepEqual(Array.from(videos, video => video.quality), ['1080p', '480p']);
});

test('UHD provider labels normalize to Nuvio 2160p while preserving HDR labels', () => {
  const api = loadInternals(() => {});
  assert.equal(api.normalizeQuality('2160p'), '2160p');
  assert.equal(api.normalizeQuality('2160P HDR10'), '2160p HDR10');
  assert.equal(api.normalizeQuality('4K'), '2160p');
  assert.equal(api.normalizeQuality('4K HDR'), '2160p HDR');
  assert.equal(api.normalizeQuality('UHD'), '2160p');
  assert.equal(api.normalizeQuality('UHD Dolby Vision'), '2160p Dolby Vision');
  assert.equal(api.normalizeQuality('3840x2160'), '2160p');
  assert.equal(api.normalizeQuality('4096 × 2160 HDR'), '2160p HDR');
  assert.equal(api.normalizeQuality('1080P'), '1080p');
  assert.equal(api.normalizeQuality(''), 'Video');
  assert.equal(api.normalizeQuality(undefined), 'Video');
});



test('player lookup retries one transient network failure and then succeeds', async () => {
  let calls = 0;
  const api = loadInternals(url => {
    if (url.includes('/shows/episodes/player/retry-player')) {
      calls++;
      if (calls === 1) return Promise.reject(new Error('fetch failed: ECONNRESET'));
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ videos: [
          { url: 'https://cdn.example/recovered.mp4', quality: '1080p' }
        ] }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const player = await api.getPlayer('retry-player', Date.now() + 5000);
  assert.equal(calls, 2);
  assert.equal(player.videos.length, 1);
});

test('player lookup does not retry permanent HTTP client errors', async () => {
  let calls = 0;
  const api = loadInternals(() => {
    calls++;
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not found')
    });
  });

  await assert.rejects(api.getPlayer('missing-player', Date.now() + 5000), /HTTP 404/);
  assert.equal(calls, 1);
});

test('player lookup retries a transient upstream 503 exactly once', async () => {
  let calls = 0;
  const api = loadInternals(() => {
    calls++;
    if (calls === 1) return Promise.resolve({
      ok: false,
      status: 503,
      text: () => Promise.resolve('temporarily unavailable')
    });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ videos: [] }))
    });
  });

  const player = await api.getPlayer('temporary-player', Date.now() + 5000);
  assert.deepEqual(Array.from(player.videos), []);
  assert.equal(calls, 2);
});

test('player network failures emit a stage-specific safe diagnostic', async () => {
  const diagnostics = [];
  const logger = {
    log() {},
    error(...args) { diagnostics.push(args); }
  };
  const api = loadInternals((url) => {
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 990, title: 'Diagnostic Movie', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/990')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          post_info: { episode_id: 9990 }
        }))
      });
    }
    if (url.includes('/shows/episodes/player/9990')) {
      return Promise.reject(new Error('network unavailable for api_key=test-secret-key'));
    }
    throw new Error('Unexpected URL: ' + url);
  }, logger);

  const result = await api.fetchStreams('movie', 'tt9900001', {
    name: 'Diagnostic Movie',
    original_name: 'Diagnostic Movie',
    year: ''
  });
  assert.deepEqual(Array.from(result.streams), []);
  const diagnostic = diagnostics.find(entry => entry[0] === '[CINEMABOX DIAGNOSTIC]');
  assert.ok(diagnostic, 'expected a structured diagnostic');
  const payload = JSON.parse(diagnostic[1]);
  assert.equal(payload.stage, 'player');
  assert.equal(payload.code, 'NETWORK_ERROR');
  assert.equal(payload.type, 'movie');
  assert.equal(payload.id, 'tt9900001');
  assert.ok(payload.message.includes('[REDACTED]'));
  assert.doesNotMatch(payload.message, /test-secret-key/);
});

test('malformed player payload is diagnosed separately from an empty player result', async () => {
  const diagnostics = [];
  const logger = { log() {}, error(...args) { diagnostics.push(args); } };
  const api = loadInternals((url) => {
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 991, title: 'Bad Player Payload', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/991')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ post_info: { episode_id: 9991 } }))
      });
    }
    if (url.includes('/shows/episodes/player/9991')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ videos: 'unexpected' }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  }, logger);

  const result = await api.fetchStreams('movie', 'tt9910001', {
    name: 'Bad Player Payload',
    original_name: 'Bad Player Payload',
    year: ''
  });
  assert.deepEqual(Array.from(result.streams), []);
  const diagnostic = diagnostics.find(entry => entry[0] === '[CINEMABOX DIAGNOSTIC]');
  assert.ok(diagnostic);
  assert.equal(JSON.parse(diagnostic[1]).code, 'PLAYER_PAYLOAD_INVALID');
});


test('public Nuvio entry point resolves TMDB movie metadata and returns three ordered qualities', async () => {
  const requests = [];
  const api = loadInternals(url => {
    requests.push(url);
    if (url.startsWith('https://api.themoviedb.org/3/movie/603?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          title: 'The Matrix',
          original_title: 'The Matrix',
          release_date: '1999-03-31',
          imdb_id: 'tt0133093'
        }))
      });
    }
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 11861, title: 'The Matrix', type: 'MOVIE', year: '1999' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/11861')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          post_info: { episode_id: 700603 }
        }))
      });
    }
    if (url.includes('/shows/episodes/player/700603')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          videos: [
            { url: 'https://cdn.example/matrix-1080.mp4?sig=1', quality: '1080p' },
            { url: 'https://cdn.example/matrix-720.mp4?sig=2', quality: '720p' },
            { url: 'https://cdn.example/matrix-480.mp4?sig=3', quality: '480p' }
          ]
        }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const streams = await api.getStreamsForNuvio({ tmdbId: '603', mediaType: 'movie' });
  assert.equal(streams.length, 3);
  assert.deepEqual(Array.from(streams, stream => stream.quality), ['1080p', '720p', '480p']);
  assert.ok(requests.some(url => url.startsWith('https://api.themoviedb.org/3/movie/603?')));
  assert.ok(streams.every(stream => stream.title.includes('The Matrix')));
});

test('TMDB authorization failures are classified and API keys stay redacted', async () => {
  const diagnostics = [];
  const logger = { log() {}, error(...args) { diagnostics.push(args); } };
  const api = loadInternals(() => Promise.resolve({
    ok: false,
    status: 401,
    text: () => Promise.resolve('Unauthorized api_key=test-secret-key')
  }), logger);

  const streams = await api.getStreamsForNuvio({ tmdbId: '603', mediaType: 'movie' });
  assert.deepEqual(Array.from(streams), []);
  const entry = diagnostics.find(item => item[0] === '[CINEMABOX DIAGNOSTIC]');
  assert.ok(entry);
  const payload = JSON.parse(entry[1]);
  assert.equal(payload.stage, 'tmdb_metadata');
  assert.equal(payload.code, 'UPSTREAM_AUTH_ERROR');
  assert.ok(payload.message.includes('[REDACTED]'));
  assert.doesNotMatch(payload.message, /test-secret-key/);
});


test('quality audit explicitly reports 2160p without logging stream URLs', async () => {
  const logs = [];
  const logger = { log() {}, error(...args) { logs.push(args.join(' ')); } };
  const api = loadInternals(url => {
    if (url.includes('/search?')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 2160, title: 'UHD Audit Movie', type: 'MOVIE' }]
        }))
      });
    }
    if (url.includes('/shows/shows/dynamic/2160')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ post_info: { episode_id: 21600 } }))
      });
    }
    if (url.includes('/shows/episodes/player/21600')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          videos: [
            { url: 'https://cdn.example/uhd-secret.mp4?token=private', quality: '2160p HDR' },
            { url: 'https://cdn.example/fullhd.mp4', quality: '1080p' }
          ]
        }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  }, logger);

  const result = await api.fetchStreams('movie', 'tt2160001', {
    name: 'UHD Audit Movie',
    original_name: 'UHD Audit Movie',
    year: ''
  });
  assert.equal(result.streams.length, 2);
  const audit = logs.find(line => line.includes('[CINEMABOX QUALITY AUDIT]'));
  assert.ok(audit, 'expected explicit quality audit log');
  const payload = JSON.parse(audit.slice(audit.indexOf('{')));
  assert.deepEqual(Array.from(payload.qualities), ['2160p HDR', '1080p']);
  assert.equal(payload.has2160p, true);
  assert.equal(payload.validUniqueStreams, 2);
  assert.doesNotMatch(audit, /uhd-secret|private/);
});


test('Nuvio entry point emits an error-level runtime marker before early exits', async () => {
  const logs = [];
  const logger = { log() {}, error(...args) { logs.push(args.join(' ')); } };
  const api = loadInternals(() => {
    throw new Error('no network request should be made for an unselected episode');
  }, logger);

  const result = await api.getStreamsForNuvio({
    tmdbId: '90228',
    mediaType: 'tv',
    season: -1,
    episode: -1
  });

  assert.deepEqual(Array.from(result), []);
  const marker = logs.find(line => line.includes('[CINEMABOX RUNTIME]'));
  assert.ok(marker, 'expected a runtime marker at plugin entry');
  const payload = JSON.parse(marker.slice(marker.indexOf('{')));
  assert.equal(payload.stage, 'start');
  assert.equal(payload.mediaType, 'tv');
  assert.equal(payload.id, '90228');
  assert.equal(payload.season, -1);
  assert.equal(payload.episode, -1);
});


test('localized title lookup returns the first valid match without waiting for a slow alternate', async () => {
  let releasePrimary;
  let primaryStarted = false;
  const primaryGate = new Promise(resolve => { releasePrimary = resolve; });
  const api = loadInternals(url => {
    const term = new URL(url).searchParams.get('term');
    if (term === 'Primary Title') {
      primaryStarted = true;
      return primaryGate;
    }
    if (term === 'Original Title') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 321, title: 'Original Title', type: 'MOVIE', year: '2021' }]
        }))
      });
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const pending = api.searchCinemaBoxTitles(
    'Primary Title',
    'Original Title',
    'movie',
    '2021',
    Date.now() + 10000
  );

  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('lookup waited for slow primary query')), 250))
  ]);

  assert.equal(primaryStarted, true, 'primary lookup should also have started');
  assert.equal(result.id, 321);
  releasePrimary({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ results: [] }))
  });
});


test('parallel title lookup prefers a stronger candidate within the confidence window', async () => {
  const api = loadInternals(url => {
    const term = new URL(url).searchParams.get('term');
    if (term === 'Primary Title') {
      return new Promise(resolve => setTimeout(() => resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 777, title: 'Primary Title', type: 'MOVIE', year: '2021' }]
        }))
      }), 45));
    }
    if (term === 'Original Title') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({
          results: [{ id: 778, title: 'Original Title Extended', type: 'MOVIE', year: '2021' }]
        }))
      });
    }
    throw new Error('Unexpected URL: ' + term);
  });

  const result = await api.searchCinemaBoxTitles(
    'Primary Title',
    'Original Title',
    'movie',
    '2021',
    Date.now() + 10000
  );

  assert.equal(result.id, 777,
    'the exact primary-title candidate should beat an earlier fuzzy alternate match');
});

test('localized and original title searches start concurrently', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const startedTerms = [];
  const api = loadInternals(url => {
    const term = new URL(url).searchParams.get('term');
    startedTerms.push(term);
    return gate.then(() => ({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        results: [{ id: term, title: term, type: 'MOVIE', year: '2020' }]
      }))
    }));
  });

  const pending = api.searchCinemaBoxTitles(
    'The Matrix',
    'ماتريكس',
    'movie',
    '2020',
    Date.now() + 10000
  );

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(startedTerms.sort(), ['The Matrix', 'ماتريكس'].sort(),
    'both title queries should be in flight before either response resolves');

  release();
  const match = await pending;
  assert.equal(match.title, 'The Matrix',
    'the primary title should win an equal-confidence tie');
});
