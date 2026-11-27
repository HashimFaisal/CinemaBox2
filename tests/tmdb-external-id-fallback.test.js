'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../index.js');

test('TMDB series lookup retries dedicated external_ids endpoint when append response omits IMDb ID', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async function (input) {
    const url = new URL(String(input));
    calls.push(url.hostname + url.pathname);

    let payload;
    if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/tv/134362') {
      payload = {
        id: 134362,
        name: 'Al Dabour',
        original_name: 'Al Dabour',
        first_air_date: '2010-08-10'
      };
    } else if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/tv/134362/external_ids') {
      payload = { id: 134362, imdb_id: 'tt6447732' };
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/search') {
      payload = { results: [] };
    } else {
      throw new Error('Unexpected mocked request: ' + url.href);
    }

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload)
    };
  };

  try {
    const streams = await plugin.getStreams({
      tmdbId: '134362',
      mediaType: 'tv',
      season: 1,
      episode: 1
    });

    assert.deepEqual(streams, []);
    assert.ok(calls.includes('api.themoviedb.org/3/tv/134362/external_ids'));
    assert.ok(calls.includes('cinema.albox.co/api/v4/search'));
  } finally {
    global.fetch = originalFetch;
  }
});
