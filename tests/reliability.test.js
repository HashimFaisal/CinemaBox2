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
    source + '\nmodule.exports.__test = { redactSensitive, cached, searchCinemaBox };',
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
