'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../index.js');

test('returns streams as soon as the first strong title query completes', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async function (input) {
    const url = new URL(String(input));
    calls.push(url.hostname + url.pathname + (url.searchParams.get('term') ? '?term=' + url.searchParams.get('term') : ''));

    let payload;
    if (url.hostname === 'v3-cinemeta.strem.io') {
      payload = { meta: {
        name: 'Fast Path Movie',
        original_name: 'Slow Alternate Movie',
        year: '2020-01-01'
      } };
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/search') {
      const term = url.searchParams.get('term');
      if (term === 'Slow Alternate Movie') {
        await new Promise(resolve => setTimeout(resolve, 800));
        payload = { results: [] };
      } else {
        payload = { results: [{
          id: 'fast-path-show',
          title: 'Fast Path Movie',
          type: 'MOVIE',
          year: '2020'
        }] };
      }
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/shows/shows/dynamic/fast-path-show') {
      payload = { post_info: { episode_id: 'fast-path-episode' } };
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/shows/episodes/player/fast-path-episode') {
      payload = { videos: [{ url: 'https://cdn.example/fast-path.mp4', quality: '1080p' }] };
    } else {
      throw new Error('Unexpected mocked request: ' + url.href);
    }

    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };

  try {
    const startedAt = Date.now();
    const streams = await plugin.getStreams({ tmdbId: 'tt7654321', mediaType: 'movie' });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(streams.length, 1);
    assert.equal(streams[0].quality, '1080p');
    assert.ok(elapsedMs < 500, 'first strong match should not wait for the slower alternate title query');
    assert.ok(calls.some(call => call.includes('term=Fast Path Movie')));
  } finally {
    global.fetch = originalFetch;
  }
});
