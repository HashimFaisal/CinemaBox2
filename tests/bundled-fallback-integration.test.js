'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TITLE = 'Archive Fallback Integration Film';
const IMDB_ID = 'tt98765432';

function response(data) {
  return {
    ok: true,
    status: 200,
    json: async function () { return data; },
    text: async function () { return JSON.stringify(data); }
  };
}

async function runPlugin(mockFetch, input) {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const logs = [];
  const calls = [];
  global.fetch = async function (url, options) {
    calls.push(String(url));
    return mockFetch(String(url), options);
  };
  console.error = function () {
    logs.push(Array.from(arguments).join(' '));
  };

  const modulePath = require.resolve('../index.js');
  delete require.cache[modulePath];
  try {
    const plugin = require('../index.js');
    const streams = await plugin.getStreams(input);
    return { streams: streams, calls: calls, logs: logs };
  } finally {
    delete require.cache[modulePath];
    global.fetch = originalFetch;
    console.error = originalError;
  }
}

function metadataResponse(type) {
  return response({
    meta: {
      name: TITLE,
      original_name: TITLE,
      year: '1920-01-01'
    }
  });
}

test('bundled Nuvio entrypoint keeps Internet Archive disabled by default', async function () {
  const result = await runPlugin(function (url) {
    if (url.startsWith('https://v3-cinemeta.strem.io/meta/movie/')) return metadataResponse('movie');
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) return response({ results: [] });
    if (url.startsWith('https://archive.org/')) throw new Error('Internet Archive must remain opt-in until live result quality and playback are verified');
    throw new Error('Unexpected URL in disabled-fallback test: ' + url);
  }, { tmdbId: IMDB_ID, mediaType: 'movie' });
  assert.deepEqual(result.streams, []);
  assert.equal(result.calls.some(function (url) { return url.startsWith('https://archive.org/'); }), false);
});

test('bundled Nuvio entrypoint does not invoke movie-only Internet Archive for series', async function () {
  const result = await runPlugin(function (url) {
    if (url.startsWith('https://v3-cinemeta.strem.io/meta/series/')) {
      return metadataResponse('series');
    }
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) {
      return response({ results: [] });
    }
    if (url.startsWith('https://archive.org/')) {
      throw new Error('Internet Archive must not be queried for series');
    }
    throw new Error('Unexpected URL in series integration test: ' + url);
  }, { tmdbId: IMDB_ID, mediaType: 'tv', season: 1, episode: 1 });

  assert.deepEqual(result.streams, []);
  assert.equal(result.calls.some(function (url) { return url.startsWith('https://archive.org/'); }), false);
});

test('bundled Nuvio entrypoint skips Internet Archive when CinemaBox returns a valid movie stream', async function () {
  const result = await runPlugin(function (url) {
    if (url.startsWith('https://v3-cinemeta.strem.io/meta/movie/')) {
      return metadataResponse('movie');
    }
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) {
      return response({
        results: [{ id: 12345, type: 'movie', title: TITLE, year: '1920' }]
      });
    }
    if (url === 'https://cinema.albox.co/api/v4/shows/shows/dynamic/12345') {
      return response({ post_info: { episode_id: 67890 } });
    }
    if (url === 'https://cinema.albox.co/api/v4/shows/episodes/player/67890') {
      return response({
        videos: [{ url: 'https://cdn.example.test/primary.mp4', quality: '1080p' }]
      });
    }
    if (url.startsWith('https://archive.org/')) {
      throw new Error('Internet Archive must be skipped after a primary stream is found');
    }
    throw new Error('Unexpected URL in primary-success integration test: ' + url);
  }, { tmdbId: IMDB_ID, mediaType: 'movie' });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].url, 'https://cdn.example.test/primary.mp4');
  assert.equal(result.calls.some(function (url) { return url.startsWith('https://archive.org/'); }), false);
});
