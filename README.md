# dsh-whale-dive

Read **Bilibili** and **Douyin** from inside [DeepSeek Harness](https://github.com/deepseek-ai/dsh): nine model-facing tools, two very different transport problems, one read-only surface.

```
whale_dive_status            pacer health, cool-downs, cookie presence, WBI key age
whale_dive_bili_video        one video: metadata, parts, uploader, counters
whale_dive_bili_feed         the popular board, or one video's related rail
whale_dive_bili_search       keyword search: video / user / article / bangumi
whale_dive_bili_author       uploader profile plus a page of their uploads
whale_dive_bili_comments     a comment page with each thread's top replies
whale_dive_bili_danmaku      the danmaku track of one part
whale_dive_bili_subtitles    subtitle tracks per part, bodies when a cookie allows
whale_dive_douyin            hot / feed / video / search / status / close
```

## Why two transports

**Bilibili** answers plain HTTPS — but it signs its newer routes with a rotating `w_rid` (the "WBI" scheme) and it answers a sustained burst with an **IP-scoped HTTP 412 that outlives the burst by minutes**. Measured on one machine: 20 threads × 10 requests passed cleanly; 8 threads of mixed `view`+`search`+`reply` for 30 seconds (≈51 req/s) produced 1372 × HTTP 412 out of 2128 requests, and the block was still in force 90 seconds later. So the plugin ships a pacing layer rather than a bare `fetch`: a token bucket keyed per host, a concurrency cap, and a circuit breaker whose cool-down doubles on each consecutive trip.

The same measurement run also showed which routes survive without a signature, so the plugin prefers those and keeps the signed route as the fallback:

| Route | Signed? | Read by |
| --- | --- | --- |
| `x/web-interface/view` | no | `bili_video` |
| `x/web-interface/popular` | no | `bili_feed` (popular) |
| `x/web-interface/related` | no | `bili_feed` (related) |
| `x/v2/reply` | no | `bili_comments` |
| `x/player/v2` | no | `bili_subtitles` |
| `x/v1/dm/list.so` | no | `bili_danmaku` |
| `x/web-interface/card` | no | `bili_author` (profile) |
| `x/relation/stat` | no | `bili_author` (counts) |
| `x/series/recArchivesByKeywords` | no | `bili_author` (uploads, default order) |
| `x/web-interface/wbi/search/type` | WBI | `bili_search` |
| `x/space/wbi/arc/search` | WBI | `bili_author` (uploads, explicit order) |

**Douyin** cannot be read over HTTP at all. Its API calls carry `a_bogus`, `X-Bogus` and `__ac_signature`, all computed at runtime inside an obfuscated VM, and a plain client gets 403s, empty bodies, or a captcha interstitial. Headless browsers get the captcha too. The only route that works is a real, headful Edge/Chrome whose page computes its own signatures — so `whale_dive_douyin` launches one in its own profile directory, drives it over the Chrome DevTools Protocol, and reads the rendered DOM.

That path costs several seconds per call, and one detail is not obvious: a window parked off-screen is treated by Chromium as occluded, and an occluded window stops painting — the feed never hydrates and the DOM stays empty. The launcher therefore passes `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`, which is what makes the parked window actually render.

## Install

```bash
dsh plugin --profile desktop add dsh-whale-dive
```

The package ships its own `cordis.patch.yml`, so the loader row is inserted for you. Nothing else in the composition is touched: no base row config is replaced, no search provider is registered, so this patch cannot collide with another plugin that selects a provider.

Restart DSH after installing — profile changes are picked up at startup.

## Configuration

All fields live under the plugin's settings section and are read on every tool call, so an edit applies to the next call without a reload.

| Key | Default | Meaning |
| --- | --- | --- |
| `requestsPerSecond` | `4` | Per-host request rate. The measured safe band is 5–10 req/s; 4 leaves headroom. |
| `burst` | `8` | Token-bucket capacity — how much idle time can be spent at once. |
| `maxConcurrent` | `3` | Requests in flight at one time. |
| `cooldownMs` | `120000` | How long one risk signal parks a host. Doubles per consecutive trip. |
| `maxCooldownMs` | `600000` | Ceiling for the doubling cool-down. |
| `timeoutMs` | `20000` | Per-request timeout. |
| `cookie` | `""` | A `SESSDATA=...` string. Only needed for subtitle bodies and the handful of routes that answer `-101` without a session. |
| `douyinBrowser` | `""` | Explicit path to Edge/Chrome. Empty auto-detects. |
| `douyinPort` | `47821` | DevTools port for the helper browser. |
| `douyinUserDataDir` | `""` | Profile directory. Empty uses a temp directory. |
| `douyinKeepAliveMs` | `900000` | How long an idle helper browser stays alive. |
| `douyinWaitMs` | `11000` | Settle time after `loadEventFired` on Douyin. Not padding — the feed hydrates asynchronously. |
| `danmakuLimit` | `500` | Default cap on danmaku rows. |
| `commentPageSize` | `20` | Default comment page size. |

## Douyin sign-in (optional)

`hot` and `feed` need no account. Keyword search does: Douyin gates it behind a login wall and shows "登录后即可搜索更多精彩视频" to anonymous visitors. To unlock it, run `whale_dive_douyin` with `action: "video"` once — this starts the helper browser — then scan the QR code in the window that appears. The session is stored in the plugin's own profile directory (never your normal browser profile) and reused afterwards.

## Output conventions

Two rules run through every tool:

- **A field is only ever omitted, never invented.** When a surface is gated, the tool still *succeeds* and explains the gate in `note`, because "this is gated and here is the way in" is a useful answer and a thrown error is not.
- **Every number is coerced.** Upstream sends `null`, missing keys and `"1.2万"`, all of which would violate the output schema; each is projected to a typed value before the harness validates it.

Rate-limit failures are the exception: they throw an `HttpError` with `code: "RISK"` and `risk: true`, carrying the cool-down window. That distinction is deliberate — a model that reads "intercepted, stop calling this host" behaves differently from one that reads "request failed" and retries into a longer ban.

## Requirements

- DSH `>= 0.2.0-rc.1 < 0.3.0-0`
- Node `>= 20` (the Douyin path uses the global `WebSocket`)
- Microsoft Edge or Google Chrome for the Douyin path; the Bilibili path needs neither

## Scope

Both backends are read-only. Nothing here posts, likes, follows or writes.

## License

MIT.
