'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function loadInternals(fetchImpl) {
  const sandbox = {
    module: { exports: {} },
    fetch: fetchImpl,
    TMDB_API_KEY: 'test-secret-key',
    console: { log() {}, error() {} }
  };
  vm.runInNewContext(
    source + '\nmodule.exports.__test = { redactSensitive, cached, searchCinemaBox, cache, CACHE_MAX_ENTRIES, uniqueStreamVideos, normalizeTitle, titleScore, findEpisode, buildStream, fetchStreams, ensureBudget };',
    sandbox,
    { filename: 'index.js' }
  );
  return sandbox.module.exports.__test;
}

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


test('a late rejected cache request cannot evict a newer value for the same key', async () => {
  const api = loadInternals(() => {});
  let rejectFirst;
  const first = api.cached('shared-key', () => new Promise((resolve, reject) => {
    rejectFirst = reject;
  }), 0);

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof rejectFirst, 'function', 'first loader should have started');
  const second = api.cached('shared-key', () => 'newer-value', 0);
  assert.equal(await second, 'newer-value');

  rejectFirst(new Error('late failure from old request'));
  await assert.rejects(first);

  let thirdLoaderCalls = 0;
  const third = await api.cached('shared-key', () => {
    thirdLoaderCalls++;
    return 'unexpected';
  }, 600000);
  assert.equal(third, 'newer-value');
  assert.equal(thirdLoaderCalls, 0);
});


test('Arabic title normalization ignores diacritics and tatweel', () => {
  const api = loadInternals(() => {});
  assert.equal(api.normalizeTitle('الْمَاتْرِكْس'), api.normalizeTitle('الماتركس'));
  assert.equal(api.titleScore('الْمَاتْرِكْس', 'الماتركس'), 1);
  assert.equal(api.normalizeTitle('مــاتريكس'), api.normalizeTitle('ماتريكس'));
});


test('stream objects expose quality as a separate Nuvio field', () => {
  const api = loadInternals(() => {});
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
