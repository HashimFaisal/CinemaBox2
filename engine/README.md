# CinemaBox Next Engine — provider core

This is an isolated orchestration prototype. It is not imported by production index.js yet.

A provider has a stable id and a getStreams(context) function. The engine currently supplies bounded concurrency, per-provider deadlines, HTTP(S) URL validation, a normalized stream shape, exact-URL deduplication that preserves signed URLs, quality-first ordering, provider priority as a tie-breaker, and per-provider failure counters with a cooldown circuit breaker.

The production CinemaBox adapter remains the only real provider until another independently verified and permitted source is implemented. This prototype does not scrape or invent providers. Before integration, confirm the Nuvio runtime's module/bundling support, add contract tests around the existing CinemaBox search/details/player path, and map internal stream objects explicitly to the Nuvio output contract.
