const CINEMA_BASE = "https://cinema.albox.co/api/v4";
const TMDB_BASE = "https://api.themoviedb.org/3";
const CACHE_SECONDS = 900;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": status === 200 ? `public, max-age=60, s-maxage=${CACHE_SECONDS}` : "no-store"
    }
  });
}
function normalizeTitle(value) {
  return String(value || "").toLowerCase()
    .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim().replace(/\s+/g, " ");
}
function titleScore(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xs = new Set(x.split(" ")), ys = new Set(y.split(" "));
  let common = 0;
  for (const word of xs) if (ys.has(word)) common++;
  return (2 * common) / (xs.size + ys.size);
}
function yearOf(value) {
  const match = String(value || "").match(/\b(?:19|20)\d{2}\b/);
  return match ? match[0] : "";
}
async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      origin: "https://cinema.albox.co",
      referer: "https://cinema.albox.co/",
      "accept-language": "en-US,en;q=0.9",
      ...headers
    }
  });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}: ${new URL(url).hostname}`);
  return response.json();
}
async function tmdbSeries(id, env) {
  if (!env.TMDB_API_KEY) throw new Error("TMDB_API_KEY secret is not configured");
  const url = new URL(`${TMDB_BASE}/tv/${encodeURIComponent(id)}`);
  url.searchParams.set("api_key", env.TMDB_API_KEY);
  url.searchParams.set("language", "ar");
  return getJson(url);
}
async function searchCinemaBox(title, year, env) {
  const url = new URL(`${CINEMA_BASE}/search`);
  url.searchParams.set("page_size", "25");
  url.searchParams.set("page_number", "1");
  url.searchParams.set("term", title);
  const data = await getJson(url.toString());
  const items = Array.isArray(data.results) ? data.results : [];
  const ranked = items.filter(item => {
    const type = String(item.type || "").toLowerCase();
    return ["tv", "series", "show"].includes(type);
  }).map(item => {
    const score = titleScore(title, item.title);
    const itemYear = yearOf(item.year);
    return { item, score, total: score + (year && itemYear ? (year === itemYear ? 0.1 : -0.1) : 0) };
  }).sort((a,b) => b.total - a.total || b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.75 || best.total < 0.75) {
    throw new Error("CinemaBox series match not confident enough");
  }
  return best.item;
}
function episodeNumber(item, index, hasExplicit) {
  const desc = String(item.description ?? "").trim();
  if (/^\d+$/.test(desc)) return Number(desc);
  const m = desc.match(/\b(?:episode|ep|e|special)\s*0*(\d+)\b/i)
    || desc.match(/\bs\s*0*\d+\s*e\s*0*(\d+)\b/i);
  if (m) return Number(m[1]);
  return hasExplicit ? null : index + 1;
}
function seasonNumber(title) {
  const value = String(title || "").trim();
  if (/^specials?$/i.test(value)) return 0;
  const m = value.match(/\d+/);
  return m ? Number(m[0]) : null;
}
function collectEpisodeVideos(details, seriesId, season) {
  const sections = Array.isArray(details.sections) ? details.sections : [];
  const section = sections.find(s => s.section_type === "episodes"
    || (Array.isArray(s.data) && s.data.some(x => String(x.card_type || "").toLowerCase() === "episode")));
  const cards = section && Array.isArray(section.data) ? section.data.filter(x =>
    x && x.id && String(x.card_type || "").toLowerCase() === "episode") : [];
  const numbered = cards.map((item, index) => ({ item, number: episodeNumber(item, index,
    cards.some(x => /^\d+$/.test(String(x.description ?? "").trim())
      || /\b(?:episode|ep|e|special)\s*0*\d+\b/i.test(String(x.description || "")))) }));
  return numbered.filter(x => Number.isInteger(x.number) && x.number > 0).map(({item, number}) => ({
    id: `tmdb:${seriesId}:${season}:${number}`,
    title: String(item.title || `Episode ${number}`),
    season,
    episode: number,
    ...(item.description ? { overview: String(item.description) } : {})
  }));
}
async function buildMeta(id, env) {
  const tmdb = await tmdbSeries(id, env);
  const title = tmdb.name || tmdb.original_name;
  if (!title) throw new Error("TMDB did not return a series title");
  const found = await searchCinemaBox(title, yearOf(tmdb.first_air_date), env);
  const root = await getJson(`${CINEMA_BASE}/shows/shows/dynamic/${encodeURIComponent(found.id)}`);
  const sections = Array.isArray(root.sections) ? root.sections : [];
  const seasonCards = [];
  for (const section of sections) {
    for (const card of (Array.isArray(section.data) ? section.data : [])) {
      if (String(card.card_type || "").toLowerCase() === "seasonposter" && card.id) {
        const season = seasonNumber(card.title);
        if (season !== null && !seasonCards.some(x => x.season === season)) {
          seasonCards.push({ id: String(card.id), season, title: String(card.title || `Season ${season}`) });
        }
      }
    }
  }
  const videos = [];
  // If the top-level details response itself represents a season, use it.
  const rootSeason = Number(root.post_info && root.post_info.season_number);
  if (Number.isInteger(rootSeason) && rootSeason >= 0) {
    videos.push(...collectEpisodeVideos(root, id, rootSeason));
  }
  // CinemaBox exposes each season as a seasonposter card; fetch that season's details.
  for (const card of seasonCards) {
    const url = new URL(`${CINEMA_BASE}/shows/shows/dynamic/${encodeURIComponent(found.id)}`);
    url.searchParams.set("season_id", card.id);
    const details = await getJson(url.toString());
    const returnedSeason = Number(details.post_info && details.post_info.season_number);
    if (!Number.isInteger(returnedSeason) || returnedSeason !== card.season) continue;
    videos.push(...collectEpisodeVideos(details, id, card.season));
  }
  const unique = new Map();
  for (const video of videos) unique.set(video.id, video);
  const sorted = [...unique.values()].sort((a,b) => a.season - b.season || a.episode - b.episode);
  return {
    meta: {
      id: `tmdb:${id}`,
      type: "series",
      name: title,
      ...(tmdb.original_name ? { original_name: tmdb.original_name } : {}),
      ...(yearOf(tmdb.first_air_date) ? { releaseInfo: yearOf(tmdb.first_air_date) } : {}),
      ...(tmdb.overview ? { description: tmdb.overview } : {}),
      ...(tmdb.poster_path ? { poster: `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` } : {}),
      ...(tmdb.backdrop_path ? { background: `https://image.tmdb.org/t/p/w1280${tmdb.backdrop_path}` } : {}),
      ...(Array.isArray(tmdb.genres) ? { genres: tmdb.genres.map(x => x.name) } : {}),
      videos: sorted
    }
  };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type"
      }
    });
    if (url.pathname === "/manifest.json") return json({
      id: "com.hashimfaisal.cinemabox-metadata",
      name: "CinemaBox Metadata",
      version: "0.1.0",
      description: "Series seasons and episodes sourced from CinemaBox.",
      types: ["series"],
      idPrefixes: ["tmdb:"],
      resources: [{ name: "meta", types: ["series"], idPrefixes: ["tmdb:"] }],
      catalogs: []
    });
    const match = url.pathname.match(/^\/meta\/series\/tmdb(?:%3A|:)(\d+)\.json$/i)
      || url.pathname.match(/^\/meta\/series\/(\d+)\.json$/i);
    if (!match) return json({ error: "Not found" }, 404);
    try {
      return json(await buildMeta(match[1], env));
    } catch (error) {
      return json({ error: "metadata_unavailable", message: String(error && error.message || error) }, 502);
    }
  }
};
