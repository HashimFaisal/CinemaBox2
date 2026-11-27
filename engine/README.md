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

## Side-by-side Nuvio test install

A separate root-level `manifest.next-test.json` uses the unique add-on ID `cinemabox-next-test` and prerelease label `2.1.7-next.11`. It points to the branch's `index.js` and is intended for side-by-side validation without replacing the official CinemaBox add-on. This test manifest is not the official `manifest.json` and must not be published as a stable release.

Test manifest URL:
`https://raw.githubusercontent.com/HashimFaisal/CinemaBox2/engine/cinemabox-next-v2/manifest.next-test.json`


## Provider health metrics (extraction, not playback)

The runtime health snapshot distinguishes productive extraction from transport failures:
- `productiveRate` is the share of provider attempts that returned at least one valid HTTP(S) stream URL. The legacy `successRate` field remains an alias for compatibility.
- `emptyResponses` counts successful provider calls that yielded no valid streams.
- `errorCount` and `timeoutCount` track failed calls; `rejectedStreams` counts invalid stream candidates.
- `validStreams` counts accepted stream candidates and `latencyEwmaMs` measures provider response latency.

These are **not playback-success metrics**. The Nuvio scraper contract supplies stream candidates but no callback when a user starts, buffers, or completes playback. Playback verification must therefore come from Nuvio player logs or an explicit future host feedback API. Ranking remains quality-first, then configured provider priority, productive extraction rate, and response latency; it must not claim that a source has been playback-verified.
