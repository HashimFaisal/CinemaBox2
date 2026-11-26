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
    source + '\nmodule.exports.__test = { redactSensitive, cached, searchCinemaBox, cache, CACHE_MAX_ENTRIES, uniqueStreamVideos, normalizeTitle, titleScore };',
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
