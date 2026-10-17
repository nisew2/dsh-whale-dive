# Changelog

## 0.1.0 — 2026-10-17

First release.

### Bilibili

- `whale_dive_bili_video` — one video's metadata, per-part list, uploader and counters.
- `whale_dive_bili_feed` — the popular board, or the related-video rail of one video.
- `whale_dive_bili_search` — keyword search across the video, user, article and bangumi verticals.
- `whale_dive_bili_author` — an uploader's profile plus a page of their uploads.
- `whale_dive_bili_comments` — a comment page with the top replies of each thread.
- `whale_dive_bili_danmaku` — the danmaku track of one part, parsed out of the XML.
- `whale_dive_bili_subtitles` — the subtitle track list of every part, with bodies when the cookie allows it.
- `whale_dive_status` — pacer counters, per-host cool-down state, cookie presence, WBI key age.

All Bilibili reads share one token-bucket pacer keyed per host, a per-host circuit
breaker with doubling cool-downs, and a rotating-key WBI signer that caches the
`img_key`/`sub_key` pair and re-signs on expiry.

### Douyin

- `whale_dive_douyin` — `hot`, `feed`, `video`, `search`, `status` and `close`,
  read from a real Edge/Chrome driven over the DevTools protocol in its own
  profile directory.

### Notes

- Bilibili's risk control answers a sustained burst with an IP-scoped HTTP 412
  that outlives the burst by minutes, so the pacer defaults to 4 req/s with a
  burst of 8 rather than running flat out.
- Douyin signs its API calls with `a_bogus`/`X-Bogus` inside an obfuscated VM and
  answers plain HTTP clients with 403s and empty bodies; a real browser is the
  only workable route, so that path costs several seconds per call.
