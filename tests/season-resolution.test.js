'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function loadInternals(fetchImpl) {
  const sandbox = {
    URL,
    module: { exports: {} },
    fetch: fetchImpl,
    TMDB_API_KEY: 'test-secret-key',
    console: { log() {}, error() {} }
  };
  vm.runInNewContext(
    source + '\nmodule.exports.__test = { findEpisode, getStreamsForNuvio, parseExternalId };',
    sandbox,
    { filename: 'index.js' }
  );
  return sandbox.module.exports.__test;
}

function response(payload) {
  return {
    ok: true,
    text: () => Promise.resolve(JSON.stringify(payload))
  };
}

test('public Nuvio entry point resolves season zero specials and preserves all three qualities', async () => {
  const requests = [];
  const api = loadInternals((url) => {
    requests.push(url);

    if (url.includes('/meta/series/tt1234567.json')) {
      return Promise.resolve(response({
        meta: { name: 'Special Series', original_name: 'Special Series', year: '2020' }
      }));
    }

    if (url.includes('/search?')) {
      return Promise.resolve(response({
        results: [{ id: 77, title: 'Special Series', type: 'TV', year: '2020' }]
      }));
    }

    if (url.includes('/shows/seasons/player/specials-id')) {
      return Promise.resolve(response({
        post_info: { season_number: 0 },
        sections: [{
          section_type: 'episodes',
          data: [{ id: 'special-episode-1', card_type: 'episode', description: 'Special 1' }]
        }]
      }));
    }

    if (url.includes('/shows/shows/dynamic/77')) {
      return Promise.resolve(response({
        post_info: { season_number: 1 },
        sections: [{
          data: [{ id: 'specials-id', card_type: 'seasonposter', title: 'Specials' }]
        }]
      }));
    }

    if (url.includes('/shows/episodes/player/special-episode-1')) {
      return Promise.resolve(response({
        videos: [
          { url: 'https://cdn.example/special-1080.mp4', quality: '1080p' },
          { url: 'https://cdn.example/special-720.mp4', quality: '720p' },
          { url: 'https://cdn.example/special-480.mp4', quality: '480p' }
        ]
      }));
    }

    throw new Error('Unexpected URL: ' + url);
  });

  const streams = await api.getStreamsForNuvio({
    tmdbId: 'tt1234567',
    mediaType: 'series',
    season: 0,
    episode: 1
  });

  assert.deepEqual(Array.from(streams, stream => stream.quality), ['1080p', '720p', '480p']);
  assert.equal(streams.length, 3);
  assert.ok(streams.every(stream => /S00E01/.test(stream.title)));
  assert.ok(requests.some(url => url.includes('/shows/seasons/player/specials-id')));
  assert.ok(requests.some(url => url.includes('/player/special-episode-1')));
});

test('season zero already loaded in initial details does not trigger another season request', async () => {
  const requests = [];
  const api = loadInternals(url => {
    requests.push(url);
    throw new Error('unexpected request');
  });

  const details = {
    post_info: { season_number: 0 },
    sections: [{
      section_type: 'episodes',
      data: [{ id: 'special-2', card_type: 'episode', description: 'S00E02' }]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-1', 0, 2), 'special-2');
  assert.equal(requests.length, 0);
});

test('season zero can be selected by an explicit Season 0 card title', async () => {
  const requests = [];
  const api = loadInternals(url => {
    requests.push(url);
    return Promise.resolve(response({
      post_info: { season_number: 0 },
      sections: [{
        section_type: 'episodes',
        data: [{ id: 'special-3', card_type: 'episode', description: 'Episode 3' }]
      }]
    }));
  });

  const details = {
    post_info: { season_number: 1 },
    sections: [{
      data: [{ id: 'season-zero-id', card_type: 'seasonposter', title: 'Season 0' }]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-1', 0, 3), 'special-3');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes('/shows/seasons/player/season-zero-id'));
});

test('a season-specific response for the wrong season is rejected', async () => {
  const api = loadInternals(() => Promise.resolve(response({
    post_info: { season_number: 1 },
    sections: [{
      section_type: 'episodes',
      data: [{ id: 'wrong-season-episode', card_type: 'episode', description: 'Episode 1' }]
    }]
  })));

  const details = {
    post_info: { season_number: 2 },
    sections: [{
      data: [{ id: 'season-zero-id', card_type: 'seasonposter', title: 'Specials' }]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-1', 0, 1), null);
});

test('missing requested season card returns no episode instead of using another season', async () => {
  const api = loadInternals(() => {
    throw new Error('must not fetch a different season');
  });

  const details = {
    post_info: { season_number: 1 },
    sections: [{
      data: [{ id: 'season-one-id', card_type: 'seasonposter', title: 'Season 1' }]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-1', 0, 1), null);
});

test('mixed numbered and unnumbered special episodes never use positional fallback', async () => {
  const api = loadInternals(() => {
    throw new Error('unexpected season fetch');
  });

  const details = {
    post_info: { season_number: 0 },
    sections: [{
      section_type: 'episodes',
      data: [
        { id: 'special-1', card_type: 'episode', description: 'Special 1' },
        { id: 'unknown-special', card_type: 'episode', description: '' },
        { id: 'special-3', card_type: 'episode', description: 'S00E03' }
      ]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-1', 0, 2), null);
  assert.equal(await api.findEpisode(details, 'show-1', 0, 3), 'special-3');
});

test('missing season metadata is not interpreted as season zero', async () => {
  const requests = [];
  const api = loadInternals(url => {
    requests.push(url);
    return Promise.resolve(response({
      post_info: { season_number: 0 },
      sections: [{
        section_type: 'episodes',
        data: [{ id: 'special-1', card_type: 'episode', description: 'Special 1' }]
      }]
    }));
  });

  const details = {
    post_info: {},
    sections: [{
      data: [{ id: 'specials-id', card_type: 'seasonposter', title: 'Specials' }]
    }]
  };

  assert.equal(await api.findEpisode(details, 'show-1', 0, 1), 'special-1');
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes('/shows/seasons/player/specials-id'));
});

test('external episode IDs retain season zero as a real numeric season', () => {
  const api = loadInternals(() => {});
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.parseExternalId('tt1234567:0:2'))),
    { imdbId: 'tt1234567', season: 0, episode: 2 }
  );
});


test('public Nuvio entry point resolves a regular TV episode and preserves ordered qualities', async () => {
  const requests = [];
  const api = loadInternals(url => {
    requests.push(url);
    if (url.includes('/meta/series/tt7654321.json')) {
      return Promise.resolve(response({
        meta: { name: 'Integration Series', original_name: 'Integration Series', year: '2022' }
      }));
    }
    if (url.includes('/search?')) {
      return Promise.resolve(response({
        results: [{ id: 880, title: 'Integration Series', type: 'TV', year: '2022' }]
      }));
    }
    if (url.includes('/shows/shows/dynamic/880')) {
      return Promise.resolve(response({
        post_info: { season_number: 2 },
        sections: [{
          section_type: 'episodes',
          data: [
            { id: 'episode-204', card_type: 'episode', description: '4' },
            { id: 'episode-205', card_type: 'episode', description: '5' }
          ]
        }]
      }));
    }
    if (url.includes('/shows/episodes/player/episode-204')) {
      return Promise.resolve(response({
        videos: [
          { url: 'https://cdn.example/series-204-1080.mp4?sig=high', quality: '1080P' },
          { url: 'https://cdn.example/series-204-720.mp4?sig=medium', quality: '720p' },
          { url: 'https://cdn.example/series-204-480.mp4?sig=low', quality: '480P' }
        ]
      }));
    }
    throw new Error('Unexpected URL: ' + url);
  });

  const streams = await api.getStreamsForNuvio({
    tmdbId: 'tt7654321',
    mediaType: 'tv',
    season: 2,
    episode: 4
  });

  assert.equal(streams.length, 3);
  assert.deepEqual(Array.from(streams, stream => stream.quality), ['1080p', '720p', '480p']);
  assert.ok(streams.every(stream => /S02E04/.test(stream.title)));
  assert.deepEqual(Array.from(streams, stream => stream.url), [
    'https://cdn.example/series-204-1080.mp4?sig=high',
    'https://cdn.example/series-204-720.mp4?sig=medium',
    'https://cdn.example/series-204-480.mp4?sig=low'
  ]);
  assert.ok(requests.some(url => url.includes('/player/episode-204')));
  assert.ok(!requests.some(url => url.includes('/player/episode-205')));
});

test('public Nuvio entry point skips series metadata when no valid episode is selected', async () => {
  const requests = [];
  const api = loadInternals(url => {
    requests.push(url);
    throw new Error('No request should be made for an unselected episode');
  });

  const streams = await api.getStreamsForNuvio({
    tmdbId: 'tt7654322',
    mediaType: 'series',
    season: -1,
    episode: -1
  });

  assert.deepEqual(Array.from(streams), []);
  assert.equal(requests.length, 0);
});
