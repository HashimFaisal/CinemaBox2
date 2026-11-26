'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderEngine, normalizeStream, qualityRank, validHttpUrl } = require('../engine/provider-engine');

test('normalizes qualities and rejects unsafe URLs', () => {
  const provider = { id: 'primary', name: 'CinemaBox' };
  assert.equal(normalizeStream({ url: 'javascript:alert(1)' }, provider), null);
  assert.equal(validHttpUrl('https://cdn.example/video.mp4?token=a%2Fb'), true);
  assert.equal(validHttpUrl('https:///missing-host.mp4'), false);
  assert.equal(validHttpUrl('https://'), false);
  assert.equal(validHttpUrl('https://user:pass@cdn.example/video.mp4'), false);
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

test('higher-priority provider wins when stream quality is equal', async () => {
  const engine = createProviderEngine({ providers: [
    { id: 'secondary', priority: 50, getStreams: async () => [
      { url: 'https://cdn.example/secondary.mp4', quality: '1080p' }
    ] },
    { id: 'primary', priority: 100, getStreams: async () => [
      { url: 'https://cdn.example/primary.mp4', quality: '1080p' }
    ] }
  ] });
  const result = await engine.getStreams({});
  assert.deepEqual(result.streams.map(stream => stream.providerId), ['primary', 'secondary']);
});

test('tracks provider latency, reliability, and valid stream yield', async () => {
  let flakyCalls = 0;
  const engine = createProviderEngine({ failureThreshold: 5, providers: [
    { id: 'steady', priority: 10, getStreams: async () => {
      await new Promise(resolve => setTimeout(resolve, 8));
      return [
        { url: 'https://cdn.example/steady-a.mp4', quality: '1080p' },
        { url: 'https://cdn.example/steady-b.mp4', quality: '720p' }
      ];
    } },
    { id: 'flaky', priority: 100, getStreams: async () => {
      flakyCalls += 1;
      if (flakyCalls === 1) throw new Error('temporary failure');
      await new Promise(resolve => setTimeout(resolve, 1));
      return [{ url: 'https://cdn.example/flaky.mp4', quality: '1080p' }];
    } }
  ] });

  await engine.getStreams({});
  const second = await engine.getStreams({});
  const health = engine.getHealth();
  assert.equal(health.steady.attempts, 2);
  assert.equal(health.steady.successes, 2);
  assert.equal(health.steady.successRate, 1);
  assert.equal(health.steady.validStreams, 4);
  assert.ok(health.steady.latencyEwmaMs >= 0);
  assert.equal(health.flaky.attempts, 2);
  assert.equal(health.flaky.successes, 1);
  assert.equal(health.flaky.successRate, 0.5);
  assert.equal(health.flaky.lastStatus, 'ok');
  assert.deepEqual(second.streams.filter(stream => stream.quality === '1080p').map(stream => stream.providerId), ['steady', 'flaky']);
});

test('empty or invalid provider results do not count as productive successes', async () => {
  const engine = createProviderEngine({ providers: [
    { id: 'empty', getStreams: async () => [{ url: 'not-a-url', quality: '1080p' }] }
  ] });
  const result = await engine.getStreams({});
  const health = engine.getHealth().empty;
  assert.equal(result.providers[0].status, 'ok');
  assert.equal(result.streams.length, 0);
  assert.equal(health.attempts, 1);
  assert.equal(health.successes, 0);
  assert.equal(health.successRate, 0);
  assert.equal(health.validStreams, 0);
  assert.equal(health.lastStatus, 'empty');
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

test('returns a fast provider result immediately and clears its timeout', async () => {
  let timerCleared = false;
  const engine = createProviderEngine({
    providerTimeoutMs: 5000,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => {
      timerCleared = true;
      clearTimeout(timer);
    },
    providers: [{
      id: 'fast',
      getStreams: async () => [{ url: 'https://cdn.example/instant.mp4', quality: '1080p' }]
    }]
  });
  const startedAt = Date.now();
  const result = await engine.getStreams({});
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.providers[0].status, 'ok');
  assert.equal(result.streams.length, 1);
  assert.ok(elapsedMs < 1000, 'fast provider should not wait for its timeout');
  assert.equal(timerCleared, true);
});

test('skips timeout timers for embedded runtimes while preserving provider deadline context', async () => {
  let timerScheduled = false;
  const deadline = Date.now() + 5000;
  const engine = createProviderEngine({
    providerTimeoutMs: 5000,
    setTimeout: () => { timerScheduled = true; return 1; },
    clearTimeout: () => {},
    providers: [{
      id: 'embedded',
      skipTimeoutTimer: true,
      getStreams: async context => {
        assert.equal(context.deadline, deadline);
        return [{ url: 'https://cdn.example/embedded.mp4', quality: '720p' }];
      }
    }]
  });
  const result = await engine.getStreams({ deadline });
  assert.equal(timerScheduled, false);
  assert.equal(result.providers[0].status, 'ok');
  assert.equal(result.streams.length, 1);
});
