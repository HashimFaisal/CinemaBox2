# CinemaBox Next Engine — provider core

The provider orchestration core is connected to the existing CinemaBox resolution path on this experimental branch.

## Runtime integration

- `cinemabox` is the first verified provider.
- Existing metadata, title matching, season/episode resolution, details/player lookup, cache, and diagnostics remain in place.
- The adapter receives the existing resolved IMDb ID, media type, metadata, and absolute deadline.
- Results are normalized internally, then mapped back to the exact four-field Nuvio stream object: `name`, `title`, `url`, and `quality`.
- The engine is bundled into `index.js` because the manifest loads a single entry file. Keep the standalone engine module and bundled implementation synchronized.

## Phase 3 — Internet Archive adapter

- Added a separate `providers/internet-archive.js` adapter using the documented Archive.org Advanced Search and Item Metadata read APIs.
- It only searches movies, requires exact normalized title and compatible year, and only emits direct media files when the item explicitly declares a Public Domain or CC0 rights marker.
- It filters out non-video files, private files, unsafe filenames, and items without an explicit permitted rights marker.
- It is registered in the provider engine but remains **disabled by default** via `ENABLE_INTERNET_ARCHIVE_PROVIDER = false`.
- Its provider-specific timeout is 5 seconds, so enabling it cannot consume the full CinemaBox request budget.
- It does not scrape third-party torrent sites or treat CinemaBox's multiple quality links as separate providers.

## Provider engine capabilities

- bounded provider concurrency
- per-provider deadlines
- HTTP(S) URL validation
- normalized stream shape
- exact-URL deduplication while preserving distinct signed URLs
- quality-first sorting and provider priority tie-break
- per-provider failure counters and cooldown circuit breaker

## Validation and release boundary

Provider contract tests use mocked Archive.org responses and verify title/year matching, file filtering, and rights checks. They do not claim live availability or real-device playback.

This branch is experimental. The official `main` version 2.1.7, manifest, releases, and tags remain unchanged. Internet Archive stays opt-in until its result quality and playback are verified in Nuvio.
