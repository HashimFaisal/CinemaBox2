'use strict';

function normalize(value) {
  return String(value || '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function yearOf(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function isPermittedLicense(metadata) {
  const license = String(metadata && (metadata.licenseurl || metadata.license_url) || '').toLowerCase();
  const rights = String(metadata && metadata.rights || '').toLowerCase();
  return /creativecommons\.org\/publicdomain\/(?:mark|zero)\/1\.0/.test(license) ||
    /public domain/.test(rights);
}

function qualityOf(filename) {
  const match = String(filename || '').match(/(?:^|[._\s-])(2160|1440|1080|720|480|360)p(?:[._\s-]|$)/i);
  return match ? match[1] + 'p' : 'Video';
}

function createInternetArchiveProvider(options) {
  const config = options || {};
  const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch : null);
  const maxResults = Math.max(1, Math.min(5, Number(config.maxResults) || 3));

  async function getJson(url) {
    if (!fetchImpl) throw new Error('Internet Archive fetch is unavailable');
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response || !response.ok) throw new Error('Internet Archive HTTP ' + (response && response.status || 'error'));
    return response.json ? response.json() : JSON.parse(await response.text());
  }

  async function getStreams(context) {
    const input = context || {};
    if (String(input.type || '').toLowerCase() !== 'movie') return [];
    const meta = input.meta || {};
    const title = String(meta.name || meta.title || meta.original_name || '').trim();
    if (!title) return [];

    const year = yearOf(meta.year || meta.release_date);
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const query = 'mediatype:movies AND title:"' + escapedTitle + '"';
    const searchUrl = 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(query) +
      '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=licenseurl&rows=' + maxResults + '&page=1&output=json';
    const search = await getJson(searchUrl);
    const docs = search && search.response && Array.isArray(search.response.docs)
      ? search.response.docs : [];

    const candidates = docs.filter(function (doc) {
      if (!doc || !doc.identifier || normalize(doc.title) !== normalize(title)) return false;
      const candidateYear = yearOf(doc.year);
      return !year || !candidateYear || year === candidateYear;
    }).slice(0, maxResults);

    const streams = [];
    for (const doc of candidates) {
      const metadataUrl = 'https://archive.org/metadata/' + encodeURIComponent(doc.identifier);
      const record = await getJson(metadataUrl);
      const metadata = record && record.metadata || {};
      if (!isPermittedLicense(metadata)) continue;
      if (normalize(metadata.title || doc.title) !== normalize(title)) continue;
      const recordYear = yearOf(metadata.year || metadata.date || doc.year);
      if (year && recordYear && year !== recordYear) continue;

      const files = Array.isArray(record.files) ? record.files : [];
      const playable = files.filter(function (file) {
        if (!file || typeof file.name !== 'string' || /[\\/]/.test(file.name) || file.name.indexOf('..') !== -1) return false;
        if (!/\.(?:mp4|m4v|webm|ogv)$/i.test(file.name)) return false;
        if (file.source === 'metadata' || file.private === true || file.private === 'true') return false;
        return Number(file.size) > 0;
      }).sort(function (a, b) {
        return Number(b.size || 0) - Number(a.size || 0);
      }).slice(0, 3);

      playable.forEach(function (file) {
        const quality = qualityOf(file.name);
        const url = 'https://archive.org/download/' + encodeURIComponent(doc.identifier) + '/' + encodeURIComponent(file.name);
        streams.push({
          name: 'Internet Archive (' + title + ') ' + quality,
          title: 'Internet Archive (' + title + ') ' + quality,
          url: url,
          quality: quality
        });
      });
      if (streams.length >= 3) break;
    }
    return streams.slice(0, 3);
  }

  return { id: 'internet-archive', name: 'Internet Archive', getStreams: getStreams };
}

module.exports = { createInternetArchiveProvider, isPermittedLicense, qualityOf };
