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

test('bundled Nuvio entrypoint invokes Internet Archive after an empty CinemaBox movie result', async function () {
  const result = await runPlugin(function (url) {
    if (url.startsWith('https://v3-cinemeta.strem.io/meta/movie/')) {
      return metadataResponse('movie');
    }
    if (url.startsWith('https://cinema.albox.co/api/v4/search?')) {
      return response({ results: [] });
    }
    if (url.startsWith('https://archive.org/advancedsearch.php?')) {
      return response({
        response: {
          numFound: 1,
          docs: [{
            identifier: 'archive-fallback-integration-film',
            title: TITLE,
            year: '1920',
            downloads: 100
          }]
        }
      });
    }
    if (url === 'https://archive.org/metadata/archive-fallback-integration-film') {
      return response({
        metadata: {
          title: TITLE,
          year: '1920',
          licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/'
        },
        files: [{
          name: 'archive-fallback-integration-film-720p.mp4',
          size: '1000000',
          format: 'MPEG4'
        }]
      });
    }
    throw new Error('Unexpected URL in fallback integration test: ' + url);
  }, { tmdbId: IMDB_ID, mediaType: 'movie' });

  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].quality, '720p');
  assert.equal(
    result.streams[0].url,
    'https://archive.org/download/archive-fallback-integration-film/archive-fallback-integration-film-720p.mp4'
  );
  assert.ok(result.calls.some(function (url) { return url.startsWith('https://archive.org/advancedsearch.php?'); }));
  assert.ok(result.logs.some(function (line) {
    return line.includes('[INTERNET ARCHIVE DIAGNOSTIC]') && line.includes('"stage":"complete"');
  }));
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
