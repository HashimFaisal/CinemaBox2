# CinemaBox Beta Performance Engine

This branch is an isolated experimental Nuvio add-on identity. It does not replace the stable `cinemabox` add-on on `main`.

- Add-on ID: `cinemabox-beta`
- Display name: `CinemaBox Beta`
- Experimental version: `2.1.8-beta.1`
- Stable baseline: `CinemaBox 2.1.8` on `main`

## Current optimization

The beta changes the retryable API failure path: the primary CinemaBox API is attempted once, then the configured transport fallback is tried immediately when the primary returns a retryable network/server error. A successful empty response remains authoritative and does not trigger fallback traffic.

This is a failure-path latency optimization. It does not claim to make successful primary requests faster, and it does not modify Nuvio's ExoPlayer implementation.

## Runtime path

`Nuvio → CinemaBox adapter → CinemaBox API → normalized direct stream candidates → Nuvio`

- Primary API: `https://cinema.albox.co/api/v4`
- Transport fallback: `https://pucinema.albox.co/api/v4`
- No new providers or hosted services are introduced.
- Internet Archive remains disabled by default.

## Existing engine behavior retained

- Bounded search work and first-page strong-match return
- In-flight request sharing and bounded LRU/TTL caches
- Shared request deadlines and retryable HTTP/network handling
- Direct HTTP(S) stream validation and known embed-page rejection
- Exact URL de-duplication and quality-first sorting
- Existing movie/TV episode resolution and Nuvio stream contract

## Playback limitation

The scraper returns candidate stream URLs. Nuvio owns ExoPlayer preparation, decoder configuration, buffering, and first-frame rendering. The beta can improve which source is returned and how quickly it is found, but cannot directly change ExoPlayer's internal startup settings. Measure source extraction time separately from Play-to-first-frame time on the device.

## Validation

Run:

```sh
npm test
```

For device comparison, use the same title, stream URL, resolution, network, and device. Record at least three cold starts per add-on and compare median source-fetch time and median Play-to-first-frame time. Also run a 10-minute uninterrupted playback check before treating any build as stable.
