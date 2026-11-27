'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('TMDB series lookup retries dedicated external_ids endpoint when append response omits IMDb ID', async () => {
  const calls = [];
  const sandbox = {
    URL,
    module: { exports: {} },
    TMDB_API_KEY: 'test-secret-key',
    console: { log() {}, error() {} },
    fetch: async function (input) {
      const url = new URL(String(input));
      calls.push(url.hostname + url.pathname);

      let payload;
      if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/tv/134362') {
        payload = { id: 134362, name: 'Al Dabour', original_name: 'Al Dabour', first_air_date: '2010-08-10' };
      } else if (url.hostname === 'api.themoviedb.org' && url.pathname === '/3/tv/134362/external_ids') {
        payload = { id: 134362, imdb_id: 'tt6447732' };
      } else if (url.hostname === 'cinema.albox.co' && url.pathname === '/api/v4/search') {
        payload = { results: [] };
      } else {
        throw new Error('Unexpected mocked request: ' + url.href);
      }

      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }
  };

  vm.runInNewContext(source, sandbox, { filename: 'index.js' });

  const streams = await sandbox.module.exports.getStreams({
    tmdbId: '134362',
    mediaType: 'tv',
    season: 1,
    episode: 1
  });

  assert.deepEqual(Array.from(streams), []);
  assert.ok(calls.includes('api.themoviedb.org/3/tv/134362/external_ids'));
  assert.ok(calls.includes('cinema.albox.co/api/v4/search'));
});
