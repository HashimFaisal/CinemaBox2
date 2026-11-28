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

test('bundled Nuvio entrypoint uses supplied metadata when TMDB lookup is unavailable', async function () {
  const result = await runPlugin(function (url) {
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) return response({ results: [] });
    if (url.startsWith('https://api.themoviedb.org/')) throw new Error('TMDB must not be queried when Nuvio supplied metadata');
    if (url.startsWith('https://archive.org/')) throw new Error('Internet Archive is disabled by default');
    throw new Error('Unexpected URL in supplied-metadata test: ' + url);
  }, {
    tmdbId: '123456',
    mediaType: 'movie',
    meta: { name: 'Supplied Metadata Film', original_name: 'Supplied Metadata Film', year: '2020-01-01' }
  });
  assert.deepEqual(result.streams, []);
  assert.equal(result.calls.some(function (url) { return url.startsWith('https://api.themoviedb.org/'); }), false);
  assert.ok(result.calls.some(function (url) { return url.startsWith('https://cinema.albox.co/api/v4/search?'); }));
});


test('bundled entrypoint uses the dedicated season-player API and forwards supplied app headers', async function () {
  const receivedHeaders = [];
  const result = await runPlugin(function (url, options) {
    receivedHeaders.push(options && options.headers || {});
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) {
      return response({ results: [{ id: 765, type: 'TV', title: TITLE, year: '2020' }] });
    }
    if (url === 'https://cinema.albox.co/api/v4/shows/shows/dynamic/765') {
      return response({
        post_info: { id: 765, title: TITLE, season_number: 1, current_season_id: 'season-1' },
        sections: []
      });
    }
    if (url === 'https://cinema.albox.co/api/v4/shows/seasons/player/season-1') {
      return response({
        episodes: [{
          id: 'episode-101',
          episode_number: 1,
          seasonNumber: 1,
          title: 'Episode 1',
          image: 'https://img.example.test/episode.jpg',
          length: 1800
        }]
      });
    }
    if (url === 'https://cinema.albox.co/api/v4/shows/episodes/player/episode-101') {
      return response({
        file: 'https://cdn.example.test/episode-101.mp4',
        quality: '1080p',
        videos: [],
        subtitles: [{ url: 'https://cdn.example.test/episode-101.en.vtt', language: 'en' }],
        parental_access: true
      });
    }
    throw new Error('Unexpected URL in season-player integration test: ' + url);
  }, {
    tmdbId: '765',
    mediaType: 'tv',
    season: 1,
    episode: 1,
    meta: { name: TITLE, original_name: TITLE, year: '2020' },
    headers: {
      'Device-Id': 'device-test',
      'Device-Model': 'Nuvio Test Device',
      'Device-OS-Version': 'Android Test',
      'App-Version': '9.9.9',
      JWT: 'jwt-test-value',
      Authorization: 'Bearer authorization-test-value'
    }
  });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].url, 'https://cdn.example.test/episode-101.mp4');
  assert.equal(result.streams[0].quality, '1080p');
  // The bundled Nuvio entrypoint intentionally exposes video fields only;
  // subtitles returned by the upstream player API are not part of its output.
  assert.equal(result.streams[0].subtitles, undefined);
  assert.ok(result.calls.some(url => url.endsWith('/shows/seasons/player/season-1')));
  assert.ok(result.calls.some(url => url.endsWith('/shows/episodes/player/episode-101')));
  for (const [key, value] of Object.entries({
    'Device-Id': 'device-test',
    'Device-Model': 'Nuvio Test Device',
    'Device-OS-Version': 'Android Test',
    'App-Version': '9.9.9',
    JWT: 'jwt-test-value',
    Authorization: 'Bearer authorization-test-value'
  })) {
    assert.ok(receivedHeaders.some(headers => headers[key] === value), 'missing forwarded header ' + key);
  }
});

test('bundled entrypoint retries the secondary API host after primary host transport failure', async function () {
  const result = await runPlugin(function (url) {
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) {
      return Promise.resolve({
        ok: false, status: 503, text: async function () { return 'upstream unavailable'; }
      });
    }
    if (url.startsWith('https://pucinema.albox.co/api/v4/search?')) {
      return response({ results: [] });
    }
    throw new Error('Unexpected URL in secondary-host integration test: ' + url);
  }, {
    tmdbId: '765',
    mediaType: 'movie',
    meta: { name: 'Secondary Host Test Film', original_name: 'Secondary Host Test Film' }
  });

  assert.deepEqual(result.streams, []);
  assert.ok(result.calls.some(url => url.startsWith('https://pucinema.albox.co/api/v4/search?')));
});
