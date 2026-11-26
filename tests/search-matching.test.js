'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function loadSearch(fetchImpl) {
  const sandbox = {
    URL,
    setTimeout,
    clearTimeout,
    AbortController,
    module: { exports: {} },
    fetch: fetchImpl,
    console: { log() {}, error() {} }
  };
  vm.runInNewContext(
    source + '\nmodule.exports.__test = { searchCinemaBox, normalizeTitle, titleScore };',
    sandbox,
    { filename: 'index.js' }
  );
  return sandbox.module.exports.__test;
}

function response(results) {
  return {
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ results }))
  };
}

test('known release-year mismatch is never accepted as the requested film', async () => {
  const api = loadSearch(() => Promise.resolve(response([
    { id: 2011, title: 'The Thing', type: 'MOVIE', year: '2011' }
  ])));

  const result = await api.searchCinemaBox('The Thing', 'movie', '1982', Date.now() + 5000);
  assert.equal(result, null);
});

test('same-title editions prefer the candidate with the requested release year', async () => {
  const api = loadSearch(() => Promise.resolve(response([
    { id: 2011, title: 'The Thing', type: 'MOVIE', year: '2011' },
    { id: 1982, title: 'The Thing', type: 'MOVIE', year: '1982' }
  ])));

  const result = await api.searchCinemaBox('The Thing', 'movie', '1982', Date.now() + 5000);
  assert.equal(result.id, 1982);
});

test('Arabic diacritics and common letter variants normalize consistently', () => {
  const api = loadSearch(() => Promise.resolve(response([])));
  assert.equal(api.normalizeTitle('القَاهِرَة'), api.normalizeTitle('القاهره'));
  assert.equal(api.normalizeTitle('أحمد'), api.normalizeTitle('احمد'));
});

test('single-word searches do not accept a longer title as an exact match', async () => {
  const api = loadSearch(() => Promise.resolve(response([
    { id: 2, title: 'Dune: Part Two', type: 'MOVIE', year: '2024' }
  ])));

  const result = await api.searchCinemaBox('Dune', 'movie', '2021', Date.now() + 5000);
  assert.equal(result, null);
});

test('search excludes results of the wrong media type', async () => {
  const api = loadSearch(() => Promise.resolve(response([
    { id: 3, title: 'Example Series', type: 'TV', year: '2020' }
  ])));

  const result = await api.searchCinemaBox('Example Series', 'movie', '2020', Date.now() + 5000);
  assert.equal(result, null);
});
