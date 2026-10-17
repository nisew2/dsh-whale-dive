# dsh-whale-dive

在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 里读 **B站** 和 **抖音**：九个面向模型的工具，两条完全不同的传输路线，一套只读接口。

```
whale_dive_status            限速器状态、冷却窗口、Cookie 是否存在、WBI 密钥剩余寿命
whale_dive_bili_video        单个视频：元数据、分P、UP主、各项计数
whale_dive_bili_feed         热门榜，或某个视频的相关推荐
whale_dive_bili_search       关键词搜索：视频 / 用户 / 专栏 / 番剧
whale_dive_bili_author       UP主资料 + 一页投稿列表
whale_dive_bili_comments     一页评论，含每条热评的回复
whale_dive_bili_danmaku      单个分P的弹幕
whale_dive_bili_subtitles    各分P的字幕轨，有 Cookie 时连正文一起读
whale_dive_douyin            hot / feed / video / search / status / close
```

## 为什么是两套传输

**B站**走普通 HTTPS —— 但它的新路由要用轮换的 `w_rid` 签名（即 WBI 方案），而且它对持续并发回的是一记 **按 IP 计、比突发本身活得久得多的 HTTP 412**。同一台机器上的实测：20 线程 × 10 次干净通过；8 线程混合 `view`+`search`+`reply` 打 30 秒（约 51 req/s），2128 次请求里吃到 1372 次 HTTP 412，且 90 秒后封锁仍在。所以这里带的是一层限速，而不是裸 `fetch`：按 host 计的令牌桶、并发上限、以及每次连续触发就翻倍的熔断冷却。

同一轮实测也测出了哪些路由免签可读，于是插件优先走它们、把签名路由留作兜底：

| 路由 | 需要签名 | 谁在读 |
| --- | --- | --- |
| `x/web-interface/view` | 否 | `bili_video` |
| `x/web-interface/popular` | 否 | `bili_feed`（热门） |
| `x/web-interface/related` | 否 | `bili_feed`（相关） |
| `x/v2/reply` | 否 | `bili_comments` |
| `x/player/v2` | 否 | `bili_subtitles` |
| `x/v1/dm/list.so` | 否 | `bili_danmaku` |
| `x/web-interface/card` | 否 | `bili_author`（资料） |
| `x/relation/stat` | 否 | `bili_author`（关注数） |
| `x/series/recArchivesByKeywords` | 否 | `bili_author`（投稿，默认排序） |
| `x/web-interface/wbi/search/type` | WBI | `bili_search` |
| `x/space/wbi/arc/search` | WBI | `bili_author`（投稿，指定排序） |

**抖音**则完全没法用 HTTP 读。它的接口带 `a_bogus`、`X-Bogus`、`__ac_signature`，三个都在页面里的混淆 VM 中实时算出；裸客户端拿到的是 403、空响应体、或验证码中间页。无头浏览器一样吃验证码。唯一可行的路线是一个真实的、有界面的 Edge/Chrome —— 页面自己算签名 —— 所以 `whale_dive_douyin` 会在自己的独立 profile 目录里拉起一个这样的浏览器，通过 Chrome DevTools 协议驱动它，读渲染后的 DOM。

这条路线每次调用要花几秒，而且有个不明显的坑：被挪到屏幕外的窗口会被 Chromium 判定为被遮挡，而被遮挡的窗口会停止绘制 —— feed 永远不 hydrate，DOM 一直是空的。所以启动参数里带了 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-background-timer-throttling`，正是这三个开关让挪到屏幕外的窗口真的会渲染。

## 安装

```bash
dsh plugin --profile desktop add dsh-whale-dive
```

包装自带 `cordis.patch.yml`，装载行会自己插进去。装配里其他东西一概不动：不替换任何基础行的配置，不注册搜索 provider，所以这一层不会跟别的「选 provider」补丁打架。

装完重启 DSH —— profile 的改动在启动时生效。

## 配置

所有字段都在插件自己的设置区，每次工具调用时现读，所以改完下一次调用就生效，不用重载。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `requestsPerSecond` | `4` | 单 host 速率。实测安全带是 5–10 req/s，4 留了余量。 |
| `burst` | `8` | 令牌桶容量 —— 空闲攒下的额度能一次花多少。 |
| `maxConcurrent` | `3` | 同时在飞的请求数。 |
| `cooldownMs` | `120000` | 一次风控信号把 host 停多久，每次连续触发翻倍。 |
| `maxCooldownMs` | `600000` | 翻倍冷却的上限。 |
| `timeoutMs` | `20000` | 单请求超时。 |
| `cookie` | `""` | `SESSDATA=...` 字符串。只有字幕正文和少数几个回 `-101` 的路由需要。 |
| `douyinBrowser` | `""` | 显式指定 Edge/Chrome 路径，空则自动探测。 |
| `douyinPort` | `47821` | 辅助浏览器监听 的 DevTools 端口。 |
| `douyinUserDataDir` | `""` | profile 目录，空则用临时目录。 |
| `douyinKeepAliveMs` | `900000` | 空闲的辅助浏览器保活多久。 |
| `douyinWaitMs` | `11000` | 抖音页 `loadEventFired` 之后的沉降时间。不是凑数 —— feed 是异步 hydrate 的。 |
| `danmakuLimit` | `500` | 弹幕条数默认上限。 |
| `commentPageSize` | `20` | 评论默认每页条数。 |

## 抖音登录（可选）

`hot` 和 `feed` 不需要账号。关键词搜索需要：抖音把它挡在登录墙后面，匿名访客看到的是「登录后即可搜索更多精彩视频」。想解锁，用 `whale_dive_douyin` 跑一次 `action: "video"`（这会拉起辅助浏览器），然后在弹出的窗口里扫码。会话存在插件自己的 profile 目录里（永远不碰你日常的浏览器 profile），之后自动复用。

## 输出约定

每个工具都遵守两条规则：

- **字段只会缺，不会编。** 某个面被墙挡住时，工具依然*成功*，并在 `note` 里说明这道墙和进去的路 —— 因为「这里被墙了，这样进去」是有用的答案，抛错不是。
- **所有数字都做类型收敛。** 上游会给 `null`、会缺键、会给 `"1.2万"`，这些都会让输出 schema 校验失败；所以每个值在交给 harness 校验前先投影成合法类型。

限流失败是例外：它抛 `HttpError`，`code: "RISK"`、`risk: true`，带上冷却窗口。这个区分是刻意的 —— 读到「被拦截了，停止调用这个 host」的模型，和读到「请求失败」然后一路重试到更长的封禁的模型，行为完全不同。

## 依赖

- DSH `>= 0.2.0-rc.1 < 0.3.0-0`
- Node `>= 20`（抖音那条路用全局 `WebSocket`）
- 抖音需要 Microsoft Edge 或 Google Chrome；B站那条路两个都不需要

## 边界

两条后端都是只读。这里没有任何发帖、点赞、关注、写入的能力。

## 许可

MIT。
