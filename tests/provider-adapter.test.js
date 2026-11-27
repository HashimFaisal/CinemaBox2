'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../index.js');

test('CinemaBox provider adapter preserves Nuvio stream contract', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async function (input) {
    const url = new URL(String(input));
    calls.push(url.hostname + url.pathname);

    let payload;
    if (url.hostname === 'v3-cinemeta.strem.io') {
      payload = { meta: { name: 'Adapter Integration Movie', original_name: 'Adapter Integration Movie', year: '2020-01-01' } };
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/search') {
      payload = { results: [{ id: 'adapter-show-1', title: 'Adapter Integration Movie', type: 'MOVIE', year: '2020' }] };
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/shows/shows/dynamic/adapter-show-1') {
      payload = { post_info: { episode_id: 'adapter-episode-1' } };
    } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/shows/episodes/player/adapter-episode-1') {
      payload = { videos: [
        { url: 'https://cdn.example/adapter-720.mp4', quality: '720p' },
        { url: 'https://cdn.example/adapter-1080.mp4', quality: '1080p' }
      ] };
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
      tmdbId: 'tt7654321',
      mediaType: 'movie'
    });

    assert.equal(streams.length, 2);
    assert.deepEqual(streams.map(stream => stream.quality), ['1080p', '720p']);
    streams.forEach(stream => {
      assert.deepEqual(Object.keys(stream).sort(), ['name', 'quality', 'title', 'url']);
      assert.match(stream.name, /^CinemaBox \(Adapter Integration Movie\)/);
      assert.equal(stream.title, stream.name);
      assert.match(stream.url, /^https:\/\//);
    });
    assert.ok(calls.some(path => path.endsWith('/api/v4/search')));
    assert.ok(calls.some(path => path.endsWith('/api/v4/shows/episodes/player/adapter-episode-1')));
  } finally {
    global.fetch = originalFetch;
  }
});
