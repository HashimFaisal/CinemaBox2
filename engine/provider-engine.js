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

function isLikelyEmbedPage(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    const knownEmbedHosts = [
      'vidsrc.to', 'vidsrc.me', 'vidsrc.xyz', 'vidsrc.cc', 'vidsrc.net',
      'vidlink.pro', 'autoembed.cc', '2embed.cc', 'smashystream.com', 'multiembed.mov'
    ];
    if (knownEmbedHosts.some(domain => host === domain || host.endsWith('.' + domain))) return true;
    return /\/(?:embed|iframe)(?:\/|$)/.test(path);
  } catch (_) { return false; }
}

function validHttpUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /\s|\\/.test(value)) return false;
  const protocolEnd = value.indexOf('://');
  if (protocolEnd < 0) return false;
  const protocol = value.slice(0, protocolEnd).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') return false;
  const authority = value.slice(protocolEnd + 3).split(/[/?#]/, 1)[0];
  if (!authority) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname) && !parsed.username && !parsed.password &&
      !isLikelyEmbedPage(value);
  } catch (_) { return false; }
}

function streamRejectionReason(stream) {
  if (!stream || typeof stream !== 'object') return 'invalid-item';
  if (typeof stream.url !== 'string' || !stream.url) return 'missing-url';
  if (!validHttpUrl(stream.url)) return 'invalid-url';
  return null;
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
  if (Array.isArray(stream.subtitles) && stream.subtitles.length) output.subtitles = stream.subtitles.slice();
  if (Number.isFinite(Number(stream.sizeBytes)) && Number(stream.sizeBytes) > 0) output.sizeBytes = Number(stream.sizeBytes);
  if (Number.isFinite(Number(stream.seeders)) && Number(stream.seeders) >= 0) output.seeders = Number(stream.seeders);
  return output;
}

function createProviderEngine(options) {
  const config = options || {};
  const providers = Array.isArray(config.providers) ? config.providers.slice() : [];
  const concurrency = Math.max(1, Math.floor(config.maxConcurrency || 3));
  const defaultTimeoutMs = Math.max(100, config.providerTimeoutMs || 8000);
  const failureThreshold = Math.max(1, Math.floor(config.failureThreshold || 2));
  const cooldownMs = Math.max(100, config.cooldownMs || 30000);
  const maxCooldownMs = Math.max(cooldownMs, Number(config.maxCooldownMs) || 300000);
  const now = config.now || Date.now;
  const schedule = config.setTimeout || (typeof setTimeout === 'function' ? setTimeout : function () { return null; });
  const cancel = config.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
  const health = new Map();

  providers.forEach(provider => {
    if (!provider || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(provider.id || '')) ||
        typeof provider.getStreams !== 'function') throw new TypeError('Invalid provider contract');
    if (!health.has(provider.id)) health.set(provider.id, {
      failures: 0, openUntil: 0, attempts: 0, successes: 0, validStreams: 0,
      emptyResponses: 0, errorCount: 0, timeoutCount: 0, rejectedStreams: 0,
      latencyEwmaMs: null, lastStatus: 'never', lastCooldownMs: 0
    });
  });

  async function runOne(provider, context) {
    const state = health.get(provider.id);
    if (provider.enabled === false) return { providerId: provider.id, status: 'disabled', streams: [] };
    if (typeof provider.supports === 'function' && !provider.supports(context)) {
      return { providerId: provider.id, status: 'unsupported', streams: [] };
    }
    if (state.openUntil > now()) return { providerId: provider.id, status: 'circuit-open', streams: [] };
    const providerTimeoutMs = Math.max(100, Number(provider.timeoutMs) || defaultTimeoutMs);
    const deadline = Math.min(Number.isFinite(context.deadline) ? context.deadline : Infinity, now() + providerTimeoutMs);
    if (deadline <= now()) return { providerId: provider.id, status: 'deadline-exceeded', streams: [] };

    const startedAt = now();
    state.attempts += 1;
    let timer;
    let timedOut = false;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const providerContext = Object.assign({}, context, {
        providerId: provider.id, deadline: deadline,
        signal: controller ? controller.signal : undefined
      });
      const work = Promise.resolve().then(() => provider.getStreams(providerContext));
      // Embedded runtimes may retain completed timeout handles after clearTimeout.
      let result;
      if (provider.skipTimeoutTimer === true) {
        result = await work;
      } else {
        const timeout = new Promise((_, reject) => {
          timer = schedule(() => {
            timedOut = true;
            if (controller) controller.abort();
            reject(new Error('PROVIDER_TIMEOUT'));
          }, Math.max(1, deadline - now()));
        });
        result = await Promise.race([work, timeout]);
        cancel(timer);
      }
      const elapsedMs = Math.max(0, now() - startedAt);
      state.failures = 0;
      state.openUntil = 0;
      state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs : (state.latencyEwmaMs * 0.7) + (elapsedMs * 0.3);
      const raw = Array.isArray(result) ? result : (result && Array.isArray(result.streams) ? result.streams : []);
      const streams = [];
      const rejectionReasons = {};
      raw.forEach(item => {
        const normalized = normalizeStream(item, provider);
        if (normalized) {
          streams.push(normalized);
        } else {
          const reason = streamRejectionReason(item) || 'invalid-stream';
          rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
        }
      });
      const rejectedStreams = raw.length - streams.length;
      state.rejectedStreams += rejectedStreams;
      if (streams.length > 0) state.successes += 1;
      else state.emptyResponses += 1;
      state.lastStatus = streams.length > 0 ? 'ok' : 'empty';
      state.validStreams += streams.length;
      return {
        providerId: provider.id,
        status: state.lastStatus,
        elapsedMs: elapsedMs,
        rawStreams: raw.length,
        rejectedStreams: rejectedStreams,
        rejectionReasons: rejectionReasons,
        streams: streams
      };
    } catch (error) {
      if (timer !== undefined) cancel(timer);
      const elapsedMs = Math.max(0, now() - startedAt);
      state.failures += 1;
      state.errorCount += 1;
      if (timedOut) state.timeoutCount += 1;
      state.lastStatus = timedOut ? 'timeout' : 'error';
      state.latencyEwmaMs = state.latencyEwmaMs == null ? elapsedMs : (state.latencyEwmaMs * 0.7) + (elapsedMs * 0.3);
      if (state.failures >= failureThreshold) {
        const exponent = Math.min(10, state.failures - failureThreshold);
        state.lastCooldownMs = Math.min(maxCooldownMs, cooldownMs * Math.pow(2, exponent));
        state.openUntil = now() + state.lastCooldownMs;
      }
      return { providerId: provider.id, status: state.lastStatus, elapsedMs: elapsedMs, streams: [] };
    }
  }

  async function getStreams(context) {
    const input = context || {};
    const results = new Array(providers.length);
    const primaryIndexes = [];
    const fallbackIndexes = [];
    providers.forEach((provider, index) => {
      (provider.fallbackOnlyWhenEmpty === true ? fallbackIndexes : primaryIndexes).push(index);
    });
    async function runIndexes(indexes) {
      let cursor = 0;
      async function worker() {
        while (true) {
          const position = cursor++;
          if (position >= indexes.length) return;
          const index = indexes[position];
          results[index] = await runOne(providers[index], input);
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, indexes.length) }, () => worker()));
    }
    await runIndexes(primaryIndexes);
    const primaryHasStreams = primaryIndexes.some(index =>
      results[index] && results[index].streams.length > 0
    );
    if (!primaryHasStreams && fallbackIndexes.length) await runIndexes(fallbackIndexes);
    fallbackIndexes.forEach(index => {
      if (!results[index]) results[index] = {
        providerId: providers[index].id,
        status: 'skipped-primary-success',
        streams: []
      };
    });
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
      const priorityDifference = Number(pb && pb.priority || 0) - Number(pa && pa.priority || 0);
      if (priorityDifference) return priorityDifference;
      const ha = health.get(a.providerId);
      const hb = health.get(b.providerId);
      const rateA = ha && ha.attempts ? ha.successes / ha.attempts : 0.5;
      const rateB = hb && hb.attempts ? hb.successes / hb.attempts : 0.5;
      if (rateB !== rateA) return rateB - rateA;
      const latencyA = ha && ha.latencyEwmaMs != null ? ha.latencyEwmaMs : Infinity;
      const latencyB = hb && hb.latencyEwmaMs != null ? hb.latencyEwmaMs : Infinity;
      return latencyA - latencyB;
    });
    return { streams: streams, providers: results };
  }

  function getHealth() {
    const snapshot = {};
    health.forEach((state, id) => {
      snapshot[id] = {
        failures: state.failures, circuitOpen: state.openUntil > now(),
        retryAt: state.openUntil > now() ? state.openUntil : null,
        cooldownMs: state.lastCooldownMs,
        attempts: state.attempts, successes: state.successes,
        successRate: state.attempts ? state.successes / state.attempts : null,
        productiveRate: state.attempts ? state.successes / state.attempts : null,
        emptyResponses: state.emptyResponses, errorCount: state.errorCount,
        timeoutCount: state.timeoutCount, rejectedStreams: state.rejectedStreams,
        validStreams: state.validStreams, latencyEwmaMs: state.latencyEwmaMs,
        lastStatus: state.lastStatus
      };
    });
    return snapshot;
  }
  return { getStreams: getStreams, getHealth: getHealth };
}

module.exports = { createProviderEngine, normalizeStream, normalizeQuality, qualityRank, validHttpUrl, streamRejectionReason };
