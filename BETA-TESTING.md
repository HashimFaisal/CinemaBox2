# CinemaBox Beta test protocol

Install only the beta manifest during the experiment:

`https://raw.githubusercontent.com/HashimFaisal/CinemaBox2/beta/performance-engine/manifest.json`

Stable add-on remains separate:

`https://raw.githubusercontent.com/HashimFaisal/CinemaBox2/main/manifest.json`

## Record separately

1. Nuvio source-list latency: tap/open streams to the moment the source list is populated.
2. Play-to-first-frame latency: tap a selected source to the first visible frame.
3. Seek recovery: seek to a fixed timestamp and measure until the picture returns.
4. Stability: 10 minutes uninterrupted at the same quality.

Use the same device, network, title, URL and quality. Repeat each cold-start test at least three times and compare medians. Do not interpret scraper extraction timing as player startup timing.

## Current scope

This first beta iteration changes only the retryable API failover policy and add-on identity. It does not change the stable branch, add providers, add hosted services, or claim an ExoPlayer-level playback optimization.
