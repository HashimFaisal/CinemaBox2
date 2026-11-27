# CinemaBox Metadata Add-on (experimental)

This Worker is a **metadata adapter**, not a stream scraper. It uses CinemaBox as the source of season and episode availability, and uses TMDB only to resolve the incoming `tmdb:<id>` identifier to a title/year for CinemaBox search.

## Why TMDB is still present

Nuvio calls metadata resources with an ID such as `tmdb:134362`; it does not send the visible series title in the metadata URL. The adapter therefore needs an ID-to-title lookup. TMDB supplies that identity only. The season cards, episode cards, numbering and episode IDs are collected from CinemaBox's `/shows/shows/dynamic/{id}` endpoint.

## Deploy

1. Create a Cloudflare Worker from `metadata-worker/src/index.js`.
2. Add a Worker secret named `TMDB_API_KEY` (TMDB v3 API key).
3. Deploy the Worker.
4. Add this manifest URL in Nuvio: `https://YOUR-WORKER.workers.dev/manifest.json`.
5. Put **CinemaBox Metadata** above the built-in TMDB metadata addon, then clear Nuvio's metadata cache or restart the app before testing.

No changes are made to CinemaBox plugin `main`, the official plugin manifest, or the existing experimental plugin branch.

## Current limitations / validation gate

- This first adapter uses CinemaBox search page 1 and requires a strong title match (score >= 0.75); ambiguous matches fail closed rather than returning the wrong show's episodes.
- The Worker code is a first implementation based on the request/response fields already handled by CinemaBox Next (`results`, `sections`, `seasonposter`, `episodes`, `post_info.season_number`). The exact live payload for the full season cards must still be validated against an actual CinemaBox API response before production use.
- The user log confirms the CinemaBox endpoints return HTTP 200, but it does not include their JSON bodies. Do not treat HTTP 200 or mocked tests as proof that all seasons/episodes map correctly.
- Some CinemaBox series may have incomplete metadata, non-standard episode numbering, or season pagination. Those need explicit handling based on observed payloads.

## Nuvio response contract

The Worker responds to `GET /meta/series/tmdb%3A{id}.json` with a Stremio-compatible `{ "meta": { "id", "type", "name", "videos": [...] } }` object. Each video ID is `tmdb:{seriesId}:{season}:{episode}`, matching the CinemaBox Next stream resolver.

## Local checks

Run `node --check metadata-worker/src/index.js`. Live API checks require a deployed Worker and a configured TMDB key.
