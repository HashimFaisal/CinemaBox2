# CinemaBox Engine

CinemaBox is a lightweight, standalone Nuvio stream scraper. The official plugin entry point is the root `index.js`; the manifest keeps one stable add-on identity: `cinemabox`.

## Runtime path

`Nuvio → CinemaBox adapter → CinemaBox API → normalized direct stream candidates → Nuvio`

- Primary API: `https://cinema.albox.co/api/v4`
- Transport fallback: `https://pucinema.albox.co/api/v4`
- The fallback is used for retryable transport/server failures. A successful empty response is not automatically treated as an outage.
- Internet Archive remains disabled by default and is not part of the active source path.

## Professional engine capabilities

1. **Speed:** bounded search work, first-page strong-match fast path, request de-duplication, in-flight promise sharing, and bounded LRU/TTL caches.
2. **Stream quality:** strict HTTP(S) URL parsing, rejection of known embed-page URLs, exact URL de-duplication, and preservation of distinct signed URLs.
3. **Reliability:** shared request deadlines, retryable HTTP/network handling, primary-to-fallback host recovery, per-provider timeouts, and a cooldown circuit breaker.
4. **Result ranking:** quality first; then configured provider priority, productive extraction history, and observed response latency. These are extraction signals, not playback-success claims.
5. **Nuvio compatibility:** one manifest entry point and the expected stream fields `name`, `title`, `url`, and `quality`; movie and selected TV episode resolution remain supported.
6. **Validation:** unit and integration tests cover URL safety, de-duplication, search fast paths, fallback behavior, time budgets, cache behavior, season/episode matching, and the public Nuvio entry point.

## Important limits

- CinemaBox does not claim to verify that a returned stream plays to completion. Playback feedback is not available through the scraper contract; device playback must be checked in Nuvio.
- A valid HTTP(S) media candidate is not proof that the remote server will remain available.
- Quality labels come from the upstream API and are not independently measured by CinemaBox.
- Do not add providers or hosted services as part of routine optimization; keep the plugin independent and lightweight.

## Test

Run the complete automated suite with:

```sh
npm test
```

The GitHub Actions workflow runs the same command on pushes and pull requests.
