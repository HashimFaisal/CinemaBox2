'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderEngine, normalizeStream, qualityRank, validHttpUrl } = require('../engine/provider-engine');

test('normalizes qualities and rejects unsafe URLs', () => {
  const provider = { id: 'primary', name: 'CinemaBox' };
  assert.equal(normalizeStream({ url: 'javascript:alert(1)' }, provider), null);
  assert.equal(validHttpUrl('https://cdn.example/video.mp4?token=a%2Fb'), true);
  assert.equal(normalizeStream({ url: 'https://cdn.example/a.mp4', quality: '4K HDR' }, provider).quality, '2160p HDR');
});

test('bounds concurrency and sorts streams by quality', async () => {
  let active = 0, peak = 0;
  const make = (id, quality) => ({ id, getStreams: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return [{ url: 'https://cdn.example/' + id + '.mp4', quality: quality }];
  }});
  const engine = createProviderEngine({ providers: [make('a', '720p'), make('b', '1080p'), make('c', '480p')], maxConcurrency: 2 });
  const result = await engine.getStreams({});
  assert.equal(peak, 2);
  assert.deepEqual(result.streams.map(item => item.quality), ['1080p', '720p', '480p']);
});

test('deduplicates exact URLs but preserves distinct signed URLs', async () => {
  const engine = createProviderEngine({ providers: [
    { id: 'one', getStreams: async () => [{ url: 'https://cdn.example/v?sig=1' }, { url: 'https://cdn.example/v?sig=1' }] },
    { id: 'two', getStreams: async () => [{ url: 'https://cdn.example/v?sig=2' }] }
  ]});
  const result = await engine.getStreams({});
  assert.deepEqual(result.streams.map(item => item.url), ['https://cdn.example/v?sig=1', 'https://cdn.example/v?sig=2']);
});

test('opens a provider circuit after repeated failures without blocking healthy providers', async () => {
  let clock = 1000;
  const engine = createProviderEngine({ now: () => clock, failureThreshold: 2, cooldownMs: 500, providers: [
    { id: 'unstable', getStreams: async () => { throw new Error('offline'); } },
    { id: 'healthy', getStreams: async () => [{ url: 'https://cdn.example/good.mp4', quality: '720p' }] }
  ]});
  await engine.getStreams({});
  await engine.getStreams({});
  const third = await engine.getStreams({});
  assert.equal(third.providers[0].status, 'circuit-open');
  assert.equal(third.streams.length, 1);
  assert.equal(engine.getHealth().unstable.circuitOpen, true);
  clock += 501;
  assert.equal((await engine.getStreams({})).providers[0].status, 'error');
});

test('disabled providers are skipped and empty responses remain valid', async () => {
  const engine = createProviderEngine({ providers: [
    { id: 'off', enabled: false, getStreams: async () => { throw new Error('must not run'); } },
    { id: 'empty', getStreams: async () => ({ streams: [] }) }
  ]});
  const result = await engine.getStreams({});
  assert.deepEqual(result.providers.map(item => item.status), ['disabled', 'ok']);
  assert.equal(result.streams.length, 0);
});

test('quality rank handles UHD and unknown labels', () => {
  assert.ok(qualityRank('2160p HDR') > qualityRank('1080p'));
  assert.ok(qualityRank('1080p') > qualityRank('720p'));
  assert.equal(qualityRank('unknown'), -1);
});


test('times out a slow provider and still returns healthy provider streams', async () => {
  const engine = createProviderEngine({ providerTimeoutMs: 100, maxConcurrency: 2, providers: [
    { id: 'slow', getStreams: () => new Promise(() => {}) },
    { id: 'fast', getStreams: async () => [{ url: 'https://cdn.example/fast.mp4', quality: '720p' }] }
  ] });
  const result = await engine.getStreams({});
  assert.equal(result.providers[0].status, 'timeout');
  assert.equal(result.providers[1].status, 'ok');
  assert.equal(result.streams.length, 1);
});

test('supports a provider-specific timeout shorter than the global budget', async () => {
  const engine = createProviderEngine({ providerTimeoutMs: 1000, providers: [
    { id: 'short', timeoutMs: 100, getStreams: () => new Promise(() => {}) }
  ] });
  const result = await engine.getStreams({});
  assert.equal(result.providers[0].status, 'timeout');
});
