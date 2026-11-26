# CinemaBox Next Engine — provider core

The provider orchestration core is now connected to the existing CinemaBox resolution path on this experimental branch.

## Runtime integration

- `cinemabox` is the first and currently only verified provider.
- The existing metadata, title matching, season/episode resolution, details lookup, player lookup, cache, and diagnostics remain in place.
- The provider adapter receives the existing resolved IMDb ID, media type, metadata, and absolute deadline.
- The engine returns normalized streams, then the adapter maps them back to the exact four-field stream object expected by the current Nuvio integration: `name`, `title`, `url`, and `quality`.
- The engine core is bundled into `index.js` because the manifest points Nuvio directly at a single entry file; the standalone `engine/provider-engine.js` remains available for focused unit tests. Keep the bundled implementation and standalone module synchronized.

## Provider engine capabilities

- bounded provider concurrency
- per-provider deadlines
- HTTP(S) URL validation
- normalized stream shape
- exact-URL deduplication while preserving distinct signed URLs
- quality-first sorting and provider priority tie-break
- per-provider failure counters and cooldown circuit breaker

## Boundaries and next steps

No additional source provider or scraper has been added. Do not interpret multiple quality links returned by CinemaBox as independent providers. A new provider must be independently verified, permitted, and covered by provider contract tests before it is enabled.

This branch is experimental. The official `main` version 2.1.7, manifest, and release metadata remain unchanged. Nuvio in-app playback still needs a real-device validation before this work is considered ready for release.
