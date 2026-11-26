'use strict';

const QUALITY = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };

function normalizeQuality(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return 'Video';
  let match = raw.match(/^(?:4\s*k|uhd)(?:\s+(.+))?$/i);
  if (match) return '2160p' + (match[1] ? ' ' + match[1].trim() : '');
  match = raw.match(/^(\d{3,4})\s*p(?:\s+(.+))?$/i) || raw.match(/^(\d{3,4})p$/i);
  return match ? match[1] + 'p' + (match[2] ? ' ' + match[2].trim() : '') : raw;
}

function qualityRank(value) {
  const match = normalizeQuality(value).match(/^(\d{3,4})p/i);
  return match ? Number(match[1]) : (QUALITY[String(value).toLowerCase()] || -1);
}

function validHttpUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /\s|\\/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch (_) { return false; }
}

function normalizeStream(stream, provider) {
  if (!stream || !validHttpUrl(stream.url)) return null;
  const quality = normalizeQuality(stream.quality || stream.resolution);
  const label = String(provider.name || provider.id) + ' ' + quality;
  const output = {
    name: String(stream.name || label),
    title: String(stream.title || label),
    url: stream.url,
    quality: quality,
    providerId: provider.id
  };
  if (stream.language) output.language = String(stream.language);
  if (Number.isFinite(Number(stream.sizeBytes)) && Number(stream.sizeBytes) > 0) output.sizeBytes = Number(stream.sizeBytes);
  if (Number.isFinite(Number(stream.seeders)) && Number(stream.seeders) >= 0) output.seeders = Number(stream.seeders);
  return output;
}

function createProviderEngine(options) {
  const config = options || {};
  const providers = Array.isArray(config.providers) ? config.providers.slice() : [];
  const concurrency = Math.max(1, Math.floor(config.maxConcurrency || 3));
  const timeoutMs = Math.max(100, config.providerTimeoutMs || 8000);
  const failureThreshold = Math.max(1, Math.floor(config.failureThreshold || 2));
  const cooldownMs = Math.max(100, config.cooldownMs || 30000);
  const now = config.now || Date.now;
  const schedule = config.setTimeout || setTimeout;
  const cancel = config.clearTimeout || clearTimeout;
  const health = new Map();

  providers.forEach(provider => {
    if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(provider.id || '')) ||
        typeof provider.getStreams !== 'function') throw new TypeError('Invalid provider contract');
    if (!health.has(provider.id)) health.set(provider.id, { failures: 0, openUntil: 0 });
  });

  async function runOne(provider, context) {
    const state = health.get(provider.id);
    if (provider.enabled === false) return { providerId: provider.id, status: 'disabled', streams: [] };
    if (state.openUntil > now()) return { providerId: provider.id, status: 'circuit-open', streams: [] };
    const deadline = Math.min(Number.isFinite(context.deadline) ? context.deadline : Infinity, now() + timeoutMs);
    if (deadline <= now()) return { providerId: provider.id, status: 'deadline-exceeded', streams: [] };

    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = schedule(() => { timedOut = true; reject(new Error('PROVIDER_TIMEOUT')); }, Math.max(1, deadline - now()));
    });
    try {
      const work = Promise.resolve().then(() => provider.getStreams(Object.assign({}, context, {
        providerId: provider.id, deadline: deadline
      })));
      const result = await Promise.race([work, timeout]);
      cancel(timer);
      state.failures = 0;
      state.openUntil = 0;
      const raw = Array.isArray(result) ? result : (result && Array.isArray(result.streams) ? result.streams : []);
      return { providerId: provider.id, status: 'ok', streams: raw.map(item => normalizeStream(item, provider)).filter(Boolean) };
    } catch (error) {
      cancel(timer);
      state.failures += 1;
      if (state.failures >= failureThreshold) state.openUntil = now() + cooldownMs;
      return { providerId: provider.id, status: timedOut ? 'timeout' : 'error', streams: [] };
    }
  }

  async function getStreams(context) {
    const input = context || {};
    const results = new Array(providers.length);
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= providers.length) return;
        results[index] = await runOne(providers[index], input);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, providers.length) }, () => worker()));
    const seen = new Set();
    const streams = [];
    results.forEach(result => result.streams.forEach(stream => {
      if (seen.has(stream.url)) return;
      seen.add(stream.url);
      streams.push(stream);
    }));
    streams.sort((a, b) => {
      const rank = qualityRank(b.quality) - qualityRank(a.quality);
      if (rank) return rank;
      const pa = providers.find(item => item.id === a.providerId);
      const pb = providers.find(item => item.id === b.providerId);
      return Number(pa && pa.priority || 0) - Number(pb && pb.priority || 0);
    });
    return { streams: streams, providers: results };
  }

  function getHealth() {
    const snapshot = {};
    health.forEach((state, id) => {
      snapshot[id] = { failures: state.failures, circuitOpen: state.openUntil > now(), retryAt: state.openUntil > now() ? state.openUntil : null };
    });
    return snapshot;
  }
  return { getStreams: getStreams, getHealth: getHealth };
}

module.exports = { createProviderEngine, normalizeStream, normalizeQuality, qualityRank, validHttpUrl };
