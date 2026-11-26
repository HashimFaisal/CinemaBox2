'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInternetArchiveProvider } = require('../providers/internet-archive');

test('returns only exact-title, year-compatible public-domain movie files', async () => {
  const calls = [];
  const provider = createInternetArchiveProvider({
    fetch: async function (url) {
      calls.push(url);
      if (url.includes('/advancedsearch.php?')) {
        return { ok: true, json: async () => ({ response: { docs: [
          { identifier: 'public-film-2020', title: 'Example Public Film', year: '2020' },
          { identifier: 'wrong-year', title: 'Example Public Film', year: '2019' },
          { identifier: 'wrong-title', title: 'Example Public Film Extended', year: '2020' }
        ] } }) };
      }
      return { ok: true, json: async () => ({
        metadata: { title: 'Example Public Film', year: '2020', licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/' },
        files: [
          { name: 'Example.Public.Film.1080p.mp4', size: '1200000', format: 'MPEG4' },
          { name: 'poster.jpg', size: '5000', format: 'JPEG' }
        ]
      }) };
    }
  });

  const streams = await provider.getStreams({ type: 'movie', meta: { name: 'Example Public Film', year: '2020-01-01' } });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].quality, '1080p');
  assert.equal(streams[0].url, 'https://archive.org/download/public-film-2020/Example.Public.Film.1080p.mp4');
  assert.equal(calls.length, 2);
});

test('rejects archive items without an explicit permitted rights marker', async () => {
  const provider = createInternetArchiveProvider({
    fetch: async function (url) {
      if (url.includes('/advancedsearch.php?')) {
        return { ok: true, json: async () => ({ response: { docs: [
          { identifier: 'unlicensed-film', title: 'Unlicensed Film', year: '2021' }
        ] } }) };
      }
      return { ok: true, json: async () => ({
        metadata: { title: 'Unlicensed Film', year: '2021' },
        files: [{ name: 'film.mp4', size: '900000' }]
      }) };
    }
  });
  const streams = await provider.getStreams({ type: 'movie', meta: { name: 'Unlicensed Film', year: '2021' } });
  assert.deepEqual(streams, []);
});

test('does not query Internet Archive for TV episodes or mismatched titles', async () => {
  let calls = 0;
  const provider = createInternetArchiveProvider({
    fetch: async function () { calls++; throw new Error('should not be called'); }
  });
  assert.deepEqual(await provider.getStreams({ type: 'series', meta: { name: 'Example' } }), []);
  assert.deepEqual(await provider.getStreams({ type: 'movie', meta: { name: 'Example', year: '2020' } }), []);
  assert.equal(calls, 0);
});
