/**
 * Tool definitions for `dsh-whale-dive`.
 *
 * Every tool here is a thin projection over two read-only subsystems: the
 * paced Bilibili web API in `./bili.js` and the CDP-driven Douyin reader in
 * `./douyin.js`. The projection is the point — the raw payloads are large,
 * unstable, and full of fields the model cannot use, so each tool reshapes one
 * call into a fixed schema that the harness validates on the way out.
 *
 * Two conventions apply throughout:
 *
 *   * A field is only ever omitted, never invented. When a surface is gated
 *     (Bilibili subtitle bodies without a cookie, Douyin keyword search without
 *     a login) the tool still succeeds and says so in `note`, because "this is
 *     gated and here is the way in" is a useful answer and a thrown error is not.
 *   * Every number is coerced through {@link int}/{@link num} so a `null`,
 *     `undefined`, or `"1.2万"` from upstream cannot violate the output schema.
 *
 * @module dsh-whale-dive/tools
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

/* ------------------------------------------------------------------ */
/* coercion helpers                                                    */
/* ------------------------------------------------------------------ */

/** Finite, non-negative-zero number, or `0` for anything unusable. */
function num(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value)) return 0;
	return Object.is(value, -0) ? 0 : value;
}

/** Truncated integer, or `0`. */
function int(raw) {
	return Math.trunc(num(raw));
}

/** String projection that never yields `undefined` or `null`. */
function str(raw) {
	if (typeof raw === "string") return raw;
	if (raw === undefined || raw === null) return "";
	return String(raw);
}

/** Plain word wrapper; upstream text is HTML-ish in places. */
function clean(raw) {
	return str(raw)
		.replace(/<\/?em\b[^>]*>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;|&ensp;|&emsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/** `H:MM:SS` / `M:SS` from seconds. */
function clock(seconds) {
	const total = Math.max(0, Math.floor(num(seconds)));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** One `text` content block — the only shape the harness renders for a tool. */
function text(body) {
	return [{ type: "text", text: body }];
}

/** Join labelled lines, dropping the ones with nothing to say. */
function lines(pairs) {
	return pairs
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([label, value]) => `${label}: ${value}`)
		.join("\n");
}

/** A compact one-line counter set, skipping zeros. */
function counter(parts) {
	const kept = parts.filter(([, value]) => num(value) > 0).map(([label, value]) => `${label} ${num(value)}`);
	return kept.length === 0 ? "no counts reported" : kept.join(" · ");
}

/* ------------------------------------------------------------------ */
/* shared output fragments                                             */
/* ------------------------------------------------------------------ */

const STAT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		view: { type: "integer" },
		danmaku: { type: "integer" },
		reply: { type: "integer" },
		like: { type: "integer" },
		coin: { type: "integer" },
		favorite: { type: "integer" },
		share: { type: "integer" },
	},
};

const FEED_ITEM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		bvid: { type: "string" },
		aid: { type: "integer" },
		cid: { type: "integer" },
		title: { type: "string" },
		author: { type: "string" },
		mid: { type: "integer" },
		url: { type: "string" },
		cover: { type: "string" },
		duration: { type: "integer" },
		durationText: { type: "string" },
		publishedAt: { type: "integer" },
		stat: STAT_SCHEMA,
	},
};

const SEARCH_ITEM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: "string" },
		title: { type: "string" },
		author: { type: "string" },
		mid: { type: "integer" },
		url: { type: "string" },
		cover: { type: "string" },
		durationText: { type: "string" },
		publishedAt: { type: "integer" },
		description: { type: "string" },
		play: { type: "integer" },
		danmaku: { type: "integer" },
		like: { type: "integer" },
		favorite: { type: "integer" },
		tags: { type: "array", items: { type: "string" } },
	},
};

const DOUYIN_CARD_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		rank: { type: "integer" },
		id: { type: "string" },
		url: { type: "string" },
		caption: { type: "string" },
		author: { type: "string" },
		date: { type: "string" },
		duration: { type: "string" },
		plays: { type: "string" },
		cover: { type: "string" },
	},
};

/** The pacing block every tool that touches the network can report. */
function pacingOf(client) {
	const snapshot = client.status();
	return {
		requests: int(snapshot.requests),
		riskSignals: int(snapshot.riskSignals),
		dispatched: int(snapshot.dispatched),
		blocked: int(snapshot.blocked),
		inflight: int(snapshot.inflight),
		queued: int(snapshot.queued),
		requestsPerSecond: num(snapshot.requestsPerSecond),
		burst: int(snapshot.burst),
		maxConcurrent: int(snapshot.maxConcurrent),
		cookie: snapshot.cookie === "configured" ? "configured" : "absent",
		wbiKeyMsRemaining: int(snapshot.wbiKeyMsRemaining),
		hosts: Object.keys(snapshot.hosts ?? {}).sort().map((host) => {
			const entry = snapshot.hosts[host];
			return {
				host: str(host),
				tokens: num(entry.tokens),
				coolingDown: entry.coolingDown === true,
				cooldownRemainingMs: int(entry.cooldownRemainingMs),
				trips: int(entry.trips),
				lastReason: str(entry.lastReason),
			};
		}),
	};
}

/* ------------------------------------------------------------------ */
/* Bilibili normalizers                                                */
/* ------------------------------------------------------------------ */

/** Project one `view`/`popular`/`related` entry into {@link FEED_ITEM_SCHEMA}. */
function feedItem(entry) {
	const stat = entry?.stat ?? {};
	return {
		bvid: str(entry?.bvid),
		aid: int(entry?.aid),
		cid: int(entry?.cid),
		title: clean(entry?.title),
		author: clean(entry?.owner?.name ?? entry?.author),
		mid: int(entry?.owner?.mid ?? entry?.mid),
		url: entry?.bvid ? `https://www.bilibili.com/video/${str(entry.bvid)}` : "",
		cover: str(entry?.pic ?? entry?.cover),
		duration: int(entry?.duration),
		durationText: clock(entry?.duration),
		publishedAt: int(entry?.pubdate ?? entry?.ctime),
		stat: {
			view: int(stat.view),
			danmaku: int(stat.danmaku),
			reply: int(stat.reply),
			like: int(stat.like),
			coin: int(stat.coin),
			favorite: int(stat.favorite),
			share: int(stat.share),
		},
	};
}

/** Split a search result's comma-joined `tag` field. */
function tagList(raw) {
	return str(raw)
		.split(",")
		.map((entry) => clean(entry))
		.filter((entry) => entry.length > 0)
		.slice(0, 20);
}

/** Project one `search/type` row into {@link SEARCH_ITEM_SCHEMA}. */
function searchItem(entry) {
	const bvid = str(entry?.bvid);
	return {
		id: bvid || str(entry?.aid),
		title: clean(entry?.title),
		author: clean(entry?.author),
		mid: int(entry?.mid),
		url: bvid ? `https://www.bilibili.com/video/${bvid}` : str(entry?.arcurl),
		cover: str(entry?.pic).replace(/^\/\//u, "https://"),
		durationText: str(entry?.duration),
		publishedAt: int(entry?.pubdate),
		description: clean(entry?.description).slice(0, 400),
		play: int(entry?.play),
		danmaku: int(entry?.video_review ?? entry?.danmaku),
		like: int(entry?.like),
		favorite: int(entry?.favorites),
		tags: tagList(entry?.tag),
	};
}

/* ------------------------------------------------------------------ */
/* tool factory                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build every tool this plugin registers.
 *
 * @param options - `bili` (a `BiliClient`), `douyin` (a `DouyinReader`),
 *   `config` (the resolved plugin config, read lazily so live edits apply).
 * @returns an array of registry-ready definitions.
 */
export function createTools({ bili, douyin, config }) {
	const limits = () => ({
		danmaku: Math.max(1, int(config()?.danmakuLimit) || 500),
		comments: Math.max(1, int(config()?.commentPageSize) || 20),
		douyinWait: Math.max(2000, int(config()?.douyinWaitMs) || 11000),
	});

	/* ---------------------------------------------------------------- */

	const statusTool = defineTool({
		name: "whale_dive_status",
		description:
			"Report the health of the whale-dive backends: the Bilibili request pacer (rate, in-flight, per-host cool-downs), whether a SESSDATA cookie is configured, how long the cached WBI signing key stays valid, and optionally whether the Douyin browser is reachable and signed in. Use it after a rate-limit or captcha error, or before a long batch of calls.",
		parameters: {
			probeDouyin: {
				type: "boolean",
				description: "Also launch/attach the Douyin browser and report its login state. Costs a browser start when it is not already running.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					bilibili: {
						type: "object",
						additionalProperties: false,
						properties: {
							requests: { type: "integer" },
							riskSignals: { type: "integer" },
							dispatched: { type: "integer" },
							blocked: { type: "integer" },
							inflight: { type: "integer" },
							queued: { type: "integer" },
							requestsPerSecond: { type: "number" },
							burst: { type: "integer" },
							maxConcurrent: { type: "integer" },
							cookie: { type: "string", enum: ["configured", "absent"] },
							wbiKeyMsRemaining: { type: "integer" },
							hosts: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										host: { type: "string" },
										tokens: { type: "number" },
										coolingDown: { type: "boolean" },
										cooldownRemainingMs: { type: "integer" },
										trips: { type: "integer" },
										lastReason: { type: "string" },
									},
								},
							},
						},
					},
					douyin: {
						type: "object",
						additionalProperties: false,
						properties: {
							probed: { type: "boolean" },
							reachable: { type: "boolean" },
							loggedIn: { type: "boolean" },
							browserRunning: { type: "boolean" },
							port: { type: "integer" },
							userDataDir: { type: "string" },
							error: { type: "string" },
						},
					},
					config: {
						type: "object",
						additionalProperties: false,
						properties: {
							requestsPerSecond: { type: "number" },
							timeoutMs: { type: "integer" },
							cookieConfigured: { type: "boolean" },
							douyinBrowser: { type: "string" },
							douyinPort: { type: "integer" },
							douyinWaitMs: { type: "integer" },
						},
					},
					note: { type: "string" },
				},
			},
			render: (_args, value) => text(
				[
					lines([
						["bilibili", `${value.bilibili.requestsPerSecond} req/s · ${value.bilibili.inflight} in flight · ${value.bilibili.queued} queued`],
						["cookie", value.bilibili.cookie],
						["wbi key", `${Math.round(value.bilibili.wbiKeyMsRemaining / 1000)}s left`],
						["risk signals", value.bilibili.riskSignals],
					]),
					value.bilibili.hosts.length > 0
						? `hosts:\n${value.bilibili.hosts.map((host) =>
							`  ${host.host} — tokens ${host.tokens}${host.coolingDown ? ` · cooling down ${Math.ceil(host.cooldownRemainingMs / 1000)}s (${host.lastReason})` : ""}${host.trips > 0 ? ` · trips ${host.trips}` : ""}`,
						).join("\n")}`
						: "",
					value.douyin.probed
						? `douyin: reachable=${value.douyin.reachable} loggedIn=${value.douyin.loggedIn} browserRunning=${value.douyin.browserRunning}${value.douyin.error ? ` error=${value.douyin.error}` : ""}`
						: "douyin: not probed (pass probeDouyin: true to check the browser and login state)",
					`config: ${value.config.requestsPerSecond} req/s · timeout ${value.config.timeoutMs}ms · cookie ${value.config.cookieConfigured ? "set" : "unset"} · douyin browser ${value.config.douyinBrowser || "auto-detected"} :${value.config.douyinPort}`,
				].filter(Boolean).join("\n"),
			),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `whale-dive status — ${value.bilibili.requestsPerSecond} req/s, cookie ${value.bilibili.cookie}`,
			}),
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const settings = config() ?? {};
			const probe = args.probeDouyin === true;
			let douyinState = {
				probed: false,
				reachable: false,
				loggedIn: false,
				browserRunning: douyin.browser.running === true,
				port: int(douyin.browser.port),
				userDataDir: str(douyin.browser.userDataDir),
			};
			if (probe) {
				const live = await douyin.status();
				douyinState = {
					probed: true,
					reachable: live.reachable === true,
					loggedIn: live.loggedIn === true,
					browserRunning: live.browserRunning === true,
					port: int(live.port),
					userDataDir: str(live.userDataDir),
					...(live.error ? { error: `${str(live.error.code)}: ${str(live.error.message)}` } : {}),
				};
			}
			return {
				bilibili: pacingOf(bili),
				douyin: douyinState,
				config: {
					requestsPerSecond: num(settings.requestsPerSecond),
					timeoutMs: int(settings.timeoutMs),
					cookieConfigured: str(settings.cookie).length > 0,
					douyinBrowser: str(settings.douyinBrowser),
					douyinPort: int(settings.douyinPort),
					douyinWaitMs: int(settings.douyinWaitMs),
				},
				note: "Bilibili pacing is host-scoped and shared by every bili tool; a cool-down listed above applies until its timer expires.",
			};
		},
		presentCall: () => ({ card: "generic", title: "whale-dive status", kind: "read" }),
	});

	/* ---------------------------------------------------------------- */

	const videoTool = defineTool({
		name: "whale_dive_bili_video",
		description:
			"Read one Bilibili video's metadata: title, description, uploader, publish time, duration, every part of a multi-part video, and the full interaction counts. Accepts a BV id, an av number, or a bilibili URL. Set includeTags to also fetch the tag list (one extra request).",
		parameters: {
			ref: { type: "string", required: true, description: "BV id (BV1xx411c7mD), av number, or a bilibili video URL." },
			includeTags: { type: "boolean", description: "Also fetch the video's tag list." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					bvid: { type: "string" },
					aid: { type: "integer" },
					cid: { type: "integer" },
					title: { type: "string" },
					description: { type: "string" },
					url: { type: "string" },
					cover: { type: "string" },
					duration: { type: "integer" },
					durationText: { type: "string" },
					publishedAt: { type: "integer" },
					owner: {
						type: "object",
						additionalProperties: false,
						properties: { mid: { type: "integer" }, name: { type: "string" } },
					},
					stat: STAT_SCHEMA,
					pages: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								cid: { type: "integer" },
								page: { type: "integer" },
								title: { type: "string" },
								duration: { type: "integer" },
								durationText: { type: "string" },
							},
						},
					},
					tags: { type: "array", items: { type: "string" } },
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`${value.title}`,
				lines([
					["bvid", value.bvid],
					["aid", String(value.aid)],
					["cid", String(value.cid)],
					["uploader", `${value.owner.name} (mid ${value.owner.mid})`],
					["duration", value.durationText],
					["published", value.publishedAt > 0 ? new Date(value.publishedAt * 1000).toISOString() : ""],
					["counts", counter(Object.entries(value.stat).map(([key, count]) => [key, count]))],
					["url", value.bvid ? `https://www.bilibili.com/video/${value.bvid}` : ""],
				]),
				value.description ? `\ndescription:\n${value.description.slice(0, 1500)}` : "",
				value.pages.length > 1
					? `\nparts:\n${value.pages.map((part) => `  P${part.page} ${part.title} (${part.durationText}) cid=${part.cid}`).join("\n")}`
					: "",
				value.tags.length > 0 ? `\ntags: ${value.tags.join(", ")}` : "",
				`\n${value.note}`,
			].filter(Boolean).join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: value.title,
				kind: "read",
				locations: value.bvid ? [{ path: `bilibili:${value.bvid}` }] : [],
			}),
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const data = await bili.video(args.ref, { signal: exec.signal });
			// `feedItem` carries author/mid too, but this schema keeps the uploader
			// in the nested `owner` field, so those two are computed and dropped.
			const { author: _author, mid: _mid, ...item } = feedItem(data);
			let tags = [];
			if (args.includeTags === true && item.bvid) {
				const listed = await bili.tags(item.bvid, { signal: exec.signal }).catch(() => []);
				tags = (Array.isArray(listed) ? listed : []).map((tag) => clean(tag?.tag_name)).filter(Boolean).slice(0, 20);
			}
			return {
				...item,
				description: clean(data?.desc),
				owner: { mid: int(data?.owner?.mid), name: clean(data?.owner?.name) },
				pages: (Array.isArray(data?.pages) ? data.pages : []).map((part) => ({
					cid: int(part?.cid),
					page: int(part?.page),
					title: clean(part?.part),
					duration: int(part?.duration),
					durationText: clock(part?.duration),
				})),
				tags,
				note: data?.copyright === 2
					? "this is a repost (copyright=2); the counts describe the repost, not the original."
					: "counts are a snapshot taken when the call ran.",
			};
		},
		presentCall: (args) => ({ card: "generic", title: `Bilibili video ${args.ref}`, kind: "read", rawInput: args.ref }),
	});

	/* ---------------------------------------------------------------- */

	const feedTool = defineTool({
		name: "whale_dive_bili_feed",
		description:
			"Read a Bilibili list surface. `popular` returns the front-page recommendation feed (works with no login and is the most reliable route on the whole API). `related` returns up to 40 videos related to a given video. Both return the same normalized item shape.",
		parameters: {
			kind: { type: "string", enum: ["popular", "related"], description: "Which list to read. Defaults to popular." },
			ref: { type: "string", description: "Required when kind is `related`: the BV id, av number, or URL to find siblings for." },
			page: { type: "integer", description: "1-based page number (popular only)." },
			pageSize: { type: "integer", description: "Items per page (popular only; the API caps this near 50)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: { type: "string" },
					page: { type: "integer" },
					count: { type: "integer" },
					items: { type: "array", items: FEED_ITEM_SCHEMA },
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`${value.kind} — ${value.count} item(s)${value.kind === "popular" ? ` on page ${value.page}` : ""}`,
				"",
				...value.items.map((entry, index) => lines([
					[`${index + 1}.`, entry.title],
					["   ", `${entry.bvid} · ${entry.author} · ${entry.durationText} · ${counter(Object.entries(entry.stat).map(([key, count]) => [key, count]))}`],
					["   ", entry.url],
				])),
				value.count === 0 ? "(no items returned)" : "",
				`\n${value.note}`,
			].filter((line) => line !== "").join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Bilibili ${value.kind} — ${value.count} items`,
				kind: "search",
			}),
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const kind = args.kind === "related" ? "related" : "popular";
			if (kind === "related") {
				if (!args.ref) throw new Error("whale_dive_bili_feed: `ref` is required when kind is `related`");
				const list = await bili.related(args.ref, { signal: exec.signal });
				const items = (Array.isArray(list) ? list : []).map(feedItem);
				return {
					kind,
					page: 0,
					count: items.length,
					items,
					note: "related videos come back in the API's own order; the list is capped near 40 by the upstream.",
				};
			}
			const data = await bili.popular({
				page: int(args.page) || 1,
				pageSize: Math.min(50, int(args.pageSize) || 20),
				signal: exec.signal,
			});
			const items = (Array.isArray(data?.list) ? data.list : []).map(feedItem);
			return {
				kind,
				page: int(args.page) || 1,
				count: items.length,
				items,
				note: "popular needs no signature and no cookie; if this route is rate limited the whole interface route group is.",
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Bilibili ${args.kind === "related" ? `related to ${args.ref}` : `popular page ${args.page ?? 1}`}`,
			kind: "search",
		}),
	});

	/* ---------------------------------------------------------------- */

	const searchTool = defineTool({
		name: "whale_dive_bili_search",
		description:
			"Search Bilibili. `scope: \"video\"` (the default) uses the WBI-signed search route and returns normalized video rows with counts. `scope: \"all\"` uses the unsigned grouped route and returns per-vertical groups. Other scopes (`user`, `article`, `bangumi`) return the raw-ish row set for that vertical. Signing happens automatically.",
		parameters: {
			keyword: { type: "string", required: true, description: "Search terms." },
			scope: { type: "string", enum: ["video", "user", "article", "bangumi", "all"], description: "Which search vertical to read. Defaults to video." },
			page: { type: "integer", description: "1-based page number." },
			pageSize: { type: "integer", description: "Results per page (signed video search only)." },
			order: { type: "string", enum: ["totalrank", "click", "pubdate", "dm", "stow", "scores"], description: "Sort order for the signed video search." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					keyword: { type: "string" },
					scope: { type: "string" },
					page: { type: "integer" },
					count: { type: "integer" },
					total: { type: "integer" },
					items: { type: "array", items: SEARCH_ITEM_SCHEMA },
					groups: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								type: { type: "string" },
								count: { type: "integer" },
								items: { type: "array", items: SEARCH_ITEM_SCHEMA },
							},
						},
					},
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`search "${value.keyword}" (${value.scope}) — ${value.count} row(s)${value.total > 0 ? ` of ${value.total} reported` : ""}`,
				"",
				...value.items.map((entry, index) => lines([
					[`${index + 1}.`, entry.title],
					["   ", `${entry.author}${entry.durationText ? ` · ${entry.durationText}` : ""} · play ${entry.play} · like ${entry.like}`],
					["   ", entry.url],
					["   ", entry.description.slice(0, 200)],
				])),
				...value.groups.flatMap((group) => [
					`\ngroup ${group.type} — ${group.count} row(s)`,
					...group.items.slice(0, 5).map((entry) => `  ${entry.title} — ${entry.author} — ${entry.url}`),
				]),
				value.count === 0 && value.groups.length === 0 ? "(no results)" : "",
				`\n${value.note}`,
			].filter((line) => line !== "").join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Bilibili search "${value.keyword}" — ${value.count} rows`,
				kind: "search",
			}),
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const scope = str(args.scope) || "video";
			const page = int(args.page) || 1;
			if (scope === "all") {
				const data = await bili.searchAll(args.keyword, { page, signal: exec.signal });
				const groups = (Array.isArray(data?.result) ? data.result : []).map((group) => {
					const rows = Array.isArray(group?.data) ? group.data : [];
					return {
						type: str(group?.result_type),
						count: int(group?.numResults ?? rows.length),
						items: rows.slice(0, 10).map((entry) => searchItem(entry)),
					};
				});
				return {
					keyword: args.keyword,
					scope,
					page,
					count: groups.reduce((sum, group) => sum + group.items.length, 0),
					total: int(data?.numResults),
					items: [],
					groups,
					note: "search/all/v2 needs no signature and returns grouped verticals; each group is capped at 10 rows here.",
				};
			}
			const type = scope === "user" ? "bili_user" : scope === "bangumi" ? "media_bangumi" : scope;
			const data = await bili.search(args.keyword, {
				type,
				page,
				pageSize: Math.min(50, int(args.pageSize) || 20),
				order: args.order ? str(args.order) : undefined,
				signal: exec.signal,
			});
			const rows = Array.isArray(data?.result) ? data.result : [];
			const items = rows.map((entry) => searchItem(entry));
			return {
				keyword: args.keyword,
				scope,
				page,
				count: items.length,
				total: int(data?.numResults ?? data?.total),
				items,
				groups: [],
				note: "this route is WBI-signed automatically; a `-352` here means the IP is being risk-controlled, not that the signature is wrong.",
			};
		},
		presentCall: (args) => ({ card: "generic", title: `Bilibili search ${args.keyword}`, kind: "search", rawInput: args.keyword }),
	});

	/* ---------------------------------------------------------------- */

	const authorTool = defineTool({
		name: "whale_dive_bili_author",
		description:
			"Read a Bilibili uploader: profile (name, signature, level), follower/following counts, and optionally their upload list. Both profile and upload routes are WBI-signed automatically and both are among the most aggressively risk-controlled routes on the API, so treat a `-352` here as a signal to slow down rather than to retry.",
		parameters: {
			mid: {
				required: true,
				oneOf: [{ type: "string", description: "The uploader's numeric mid, as text." }, { type: "integer", description: "The same mid as a number." }],
				description: "The uploader's numeric mid.",
			},
			withVideos: { type: "boolean", description: "Also fetch the upload list." },
			page: { type: "integer", description: "1-based page for the upload list." },
			pageSize: { type: "integer", description: "Uploads per page." },
			order: { type: "string", enum: ["pubdate", "click", "stow"], description: "Upload ordering." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					mid: { type: "integer" },
					name: { type: "string" },
					sign: { type: "string" },
					face: { type: "string" },
					level: { type: "integer" },
					fans: { type: "integer" },
					following: { type: "integer" },
					likes: { type: "integer" },
					page: { type: "integer" },
					count: { type: "integer" },
					items: { type: "array", items: FEED_ITEM_SCHEMA },
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`${value.name} (mid ${value.mid})`,
				lines([
					["level", String(value.level)],
					["fans", String(value.fans)],
					["following", String(value.following)],
					["likes", String(value.likes)],
					["sign", value.sign.slice(0, 200)],
				]),
				value.count > 0
					? `\nuploads page ${value.page} — ${value.count} item(s)\n${value.items.map((entry, index) =>
						`  ${index + 1}. ${entry.title} · ${entry.bvid} · ${entry.durationText} · ${counter([["view", entry.stat.view], ["like", entry.stat.like]])}\n     ${entry.url}`,
					).join("\n")}`
					: "",
				`\n${value.note}`,
			].filter(Boolean).join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Bilibili uploader ${value.name || value.mid}`,
				kind: "read",
			}),
		},
		timeoutMs: 90000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const mid = int(args.mid);
			if (mid <= 0) throw new Error(`whale_dive_bili_author: "${str(args.mid)}" is not a numeric mid`);
			const profile = await bili.userInfo(mid, { signal: exec.signal });
			const relation = await bili.relation(mid, { signal: exec.signal }).catch(() => ({}));
			let items = [];
			let page = 0;
			let listed = "";
			if (args.withVideos === true) {
				page = int(args.page) || 1;
				const uploads = await bili.userVideos(mid, {
					page,
					pageSize: Math.min(50, int(args.pageSize) || 20),
					order: args.order ? str(args.order) : "pubdate",
					signal: exec.signal,
				});
				const rows = Array.isArray(uploads?.items) ? uploads.items : [];
				listed = str(uploads?.source);
				items = rows.map((entry) => feedItem({ ...entry, owner: { mid, name: profile?.name } }));
			}
			return {
				mid,
				name: clean(profile?.name),
				sign: clean(profile?.sign),
				face: str(profile?.face),
				level: int(profile?.level),
				fans: int(relation?.follower),
				following: int(relation?.following),
				likes: int(profile?.likes ?? relation?.like_num),
				page,
				count: items.length,
				items,
				note: args.withVideos === true
					? "the upload list is signed with the rotating WBI key; the keys are cached for ten minutes and refreshed on expiry."
					: "profile only — pass withVideos: true to also read the upload list.",
			};
		},
		presentCall: (args) => ({ card: "generic", title: `Bilibili uploader ${args.mid}`, kind: "read", rawInput: args.mid }),
	});

	/* ---------------------------------------------------------------- */

	const commentsTool = defineTool({
		name: "whale_dive_bili_comments",
		description:
			"Read a Bilibili video's comment page. Returns top-level comments with their most-liked replies, the total comment count, and whether more pages exist. Sort by hot (default) or by time.",
		parameters: {
			ref: { type: "string", required: true, description: "BV id, av number, or bilibili video URL." },
			page: { type: "integer", description: "1-based comment page." },
			pageSize: { type: "integer", description: "Comments per page." },
			sort: { type: "string", enum: ["hot", "time"], description: "Comment ordering. Defaults to hot." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					aid: { type: "integer" },
					total: { type: "integer" },
					page: { type: "integer" },
					count: { type: "integer" },
					hasMore: { type: "boolean" },
					items: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								rpid: { type: "integer" },
								user: { type: "string" },
								mid: { type: "integer" },
								message: { type: "string" },
								like: { type: "integer" },
								floor: { type: "integer" },
								createdAt: { type: "integer" },
								replies: {
									type: "array",
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											user: { type: "string" },
											mid: { type: "integer" },
											message: { type: "string" },
											like: { type: "integer" },
										},
									},
								},
							},
						},
					},
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`${value.total} comment(s) total — showing ${value.count} from page ${value.page}`,
				"",
				...value.items.flatMap((entry, index) => [
					`${index + 1}. ${entry.user} (floor ${entry.floor}, ${entry.like} likes)`,
					`   ${entry.message.slice(0, 500)}`,
					...entry.replies.map((reply) => `   ↳ ${reply.user} (${reply.like}): ${reply.message.slice(0, 300)}`),
				]),
				value.count === 0 ? "(no comments on this page)" : "",
				`\n${value.note}`,
			].filter((line) => line !== "").join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Bilibili comments — ${value.count} of ${value.total}`,
				kind: "read",
			}),
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const view = await bili.video(args.ref, { signal: exec.signal });
			const aid = int(view?.aid);
			const page = int(args.page) || 1;
			const data = await bili.comments(aid, {
				page,
				pageSize: Math.min(50, int(args.pageSize) || limits().comments),
				sort: args.sort === "time" ? 0 : 2,
				signal: exec.signal,
			});
			const rows = Array.isArray(data?.replies) ? data.replies : [];
			return {
				aid,
				total: int(data?.page?.count ?? view?.stat?.reply),
				page,
				count: rows.length,
				hasMore: page < int(data?.page?.count ? Math.ceil(num(data.page.count) / Math.max(1, int(data?.page?.size) || 20)) : 1),
				items: rows.map((row) => ({
					rpid: int(row?.rpid),
					user: clean(row?.member?.uname),
					mid: int(row?.member?.mid),
					message: clean(row?.content?.message),
					like: int(row?.like),
					floor: int(row?.floor),
					createdAt: int(row?.ctime),
					replies: (Array.isArray(row?.replies) ? row.replies : []).slice(0, 3).map((reply) => ({
						user: clean(reply?.member?.uname),
						mid: int(reply?.member?.mid),
						message: clean(reply?.content?.message),
						like: int(reply?.like),
					})),
				})),
				note: "replies beyond the first few per comment are nested in later pages; the `reply` route is one of the risk-controlled ones.",
			};
		},
		presentCall: (args) => ({ card: "generic", title: `Bilibili comments ${args.ref}`, kind: "read", rawInput: args.ref }),
	});

	/* ---------------------------------------------------------------- */

	const danmakuTool = defineTool({
		name: "whale_dive_bili_danmaku",
		description:
			"Fetch the danmaku (scrolling-comment) overlay for one part of a Bilibili video. Danmaku live in a pool keyed by cid, so the tool resolves a video reference to its cid first unless you pass a cid directly. Returns each comment with its timestamp in milliseconds into the video.",
		parameters: {
			ref: { type: "string", description: "BV id, av number, or URL — used to resolve the cid when `cid` is absent." },
			cid: { type: "integer", description: "Part cid, when it is already known." },
			limit: { type: "integer", description: "Maximum rows to return. Defaults to the configured danmaku limit." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					cid: { type: "integer" },
					bvid: { type: "string" },
					pool: { type: "integer" },
					total: { type: "integer" },
					truncated: { type: "boolean" },
					rows: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								text: { type: "string" },
								timeMs: { type: "integer" },
								timeText: { type: "string" },
								mode: { type: "integer" },
								color: { type: "integer" },
								sentAt: { type: "integer" },
							},
						},
					},
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`danmaku for cid ${value.cid} — ${value.total} row(s)${value.truncated ? " (truncated)" : ""}`,
				"",
				...value.rows.slice(0, 60).map((row) => `[${row.timeText}] ${row.text}`),
				value.total > 60 ? `… ${value.total - 60} more rows in the structured value` : "",
				`\n${value.note}`,
			].filter((line) => line !== "").join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Bilibili danmaku cid ${value.cid} — ${value.total} rows`,
				kind: "read",
			}),
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			let cid = int(args.cid);
			let bvid = "";
			if (cid <= 0) {
				if (!args.ref) throw new Error("whale_dive_bili_danmaku: pass either `ref` or `cid`");
				const view = await bili.video(args.ref, { signal: exec.signal });
				cid = int(view?.cid);
				bvid = str(view?.bvid);
			}
			const limit = Math.max(1, Math.min(5000, int(args.limit) || limits().danmaku));
			const parsed = await bili.danmaku(cid, { limit, signal: exec.signal });
			return {
				cid,
				bvid,
				pool: parsed.rows.length,
				total: parsed.total,
				truncated: parsed.truncated === true,
				rows: parsed.rows.map((row) => ({
					text: clean(row.text).slice(0, 300),
					timeMs: int(row.timeMs),
					timeText: clock(row.timeMs / 1000),
					mode: int(row.mode),
					color: int(row.color),
					sentAt: int(row.sentAt),
				})),
				note: "the `.so` route serves the whole pool, so `limit` truncates a list that is often tens of thousands of rows long.",
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Bilibili danmaku ${args.cid ? `cid ${args.cid}` : args.ref}`,
			kind: "read",
			rawInput: args.cid ? String(args.cid) : args.ref,
		}),
	});

	/* ---------------------------------------------------------------- */

	const subtitlesTool = defineTool({
		name: "whale_dive_bili_subtitles",
		description:
			"List the subtitle tracks of a Bilibili video (per part) and, when they are readable, their bodies. Bilibili gates subtitle bodies behind a signed-in session: without a SESSDATA cookie in the plugin config the track list still comes back but every `subtitle_url` is empty, and this tool says so instead of inventing cues. Set includeBody to attempt the download.",
		parameters: {
			ref: { type: "string", required: true, description: "BV id, av number, or bilibili video URL." },
			cid: { type: "integer", description: "Read only this part's tracks." },
			includeBody: { type: "boolean", description: "Also download and parse the cue bodies of readable tracks." },
			maxTracks: { type: "integer", description: "Cap on bodies to download. Defaults to 3." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					bvid: { type: "string" },
					aid: { type: "integer" },
					title: { type: "string" },
					needLogin: { type: "boolean" },
					available: { type: "boolean" },
					parts: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								cid: { type: "integer" },
								part: { type: "string" },
								needLogin: { type: "boolean" },
								tracks: {
									type: "array",
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											lan: { type: "string" },
											lanDoc: { type: "string" },
											locked: { type: "boolean" },
											url: { type: "string" },
											author: { type: "string" },
										},
									},
								},
							},
						},
					},
					bodies: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								lan: { type: "string" },
								lanDoc: { type: "string" },
								cueCount: { type: "integer" },
								cues: {
									type: "array",
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											from: { type: "number" },
											to: { type: "number" },
											timeText: { type: "string" },
											text: { type: "string" },
										},
									},
								},
							},
						},
					},
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`subtitles for ${value.bvid || "video"} — ${value.available ? "bodies readable" : "track list only"}`,
				lines([
					["title", value.title],
					["needLogin", String(value.needLogin)],
				]),
				"",
				...value.parts.map((part) => [
					`cid ${part.cid}${part.part ? ` (${part.part})` : ""} — ${part.tracks.length} track(s)${part.needLogin ? " · login required" : ""}`,
					...part.tracks.map((track) => `  ${track.lan} ${track.lanDoc}${track.locked ? " [locked]" : ""} ${track.url ? `→ ${track.url.slice(0, 120)}` : "(no url)"}`),
				].join("\n")),
				...value.bodies.map((body) => [
					`\nbody ${body.lan} ${body.lanDoc} — ${body.cueCount} cue(s)`,
					...body.cues.slice(0, 40).map((cue) => `  [${cue.timeText}] ${cue.text}`),
					body.cueCount > 40 ? `  … ${body.cueCount - 40} more cues` : "",
				].filter(Boolean).join("\n")),
				`\n${value.note}`,
			].filter((line) => line !== "").join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Bilibili subtitles ${value.bvid} — ${value.available ? "readable" : "gated"}`,
				kind: "read",
			}),
		},
		timeoutMs: 90000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const listed = await bili.subtitles(args.ref, int(args.cid) || undefined, { signal: exec.signal });
			const bodies = [];
			if (args.includeBody === true && listed.available === true) {
				const cap = Math.max(1, Math.min(10, int(args.maxTracks) || 3));
				const targets = [];
				for (const part of listed.parts) {
					for (const track of part.tracks) {
						if (track.url && targets.length < cap) targets.push(track);
					}
				}
				for (const track of targets) {
					try {
						const cues = await bili.subtitleBody(track.url, { signal: exec.signal });
						bodies.push({
							lan: str(track.lan),
							lanDoc: str(track.lanDoc),
							cueCount: cues.length,
							cues: cues.slice(0, 2000).map((cue) => ({
								from: num(cue.from),
								to: num(cue.to),
								timeText: clock(cue.from),
								text: clean(cue.text).slice(0, 500),
							})),
						});
					} catch {
						// A single unreadable track must not sink the whole listing.
					}
				}
			}
			return {
				bvid: str(listed.bvid),
				aid: int(listed.aid),
				title: clean(listed.title),
				needLogin: listed.needLogin === true,
				available: listed.available === true,
				parts: (Array.isArray(listed.parts) ? listed.parts : []).map((part) => ({
					cid: int(part.cid),
					part: clean(part.part),
					needLogin: part.needLogin === true,
					tracks: (Array.isArray(part.tracks) ? part.tracks : []).map((track) => ({
						lan: str(track.lan),
						lanDoc: clean(track.lanDoc),
						locked: track.locked === true,
						url: str(track.url),
						author: clean(track.author),
					})),
				})),
				bodies,
				note: str(listed.note),
			};
		},
		presentCall: (args) => ({ card: "generic", title: `Bilibili subtitles ${args.ref}`, kind: "read", rawInput: args.ref }),
	});

	/* ---------------------------------------------------------------- */

	const douyinTool = defineTool({
		name: "whale_dive_douyin",
		description:
			"Read Douyin through a real browser driven over the Chrome DevTools Protocol. Douyin signs its API calls with `a_bogus`/`X-Bogus` computed inside an obfuscated VM and answers plain HTTP clients with 403s, so a browser that computes its own signatures is the only workable route. Actions: `hot` (the hot board — no login needed), `feed` (the 精选/推荐 feed), `video` (one video's caption, counts, publish time, and comments), `search` (keyword search — Douyin gates this behind a login wall), `status`, and `close` (shut the helper browser down).",
		parameters: {
			action: { type: "string", enum: ["hot", "feed", "video", "search", "status", "close"], required: true, description: "Which surface to read." },
			ref: { type: "string", description: "For `video`: an aweme id, a douyin video URL, or a v.douyin.com short link." },
			keyword: { type: "string", description: "For `search`: the query." },
			limit: { type: "integer", description: "Maximum cards to return. Defaults to 30." },
			commentLimit: { type: "integer", description: "For `video`: maximum comments to return. Defaults to 30." },
			includeRawText: { type: "boolean", description: "For `video`: include the page's full flattened text." },
			waitMs: { type: "integer", description: "Extra settle time after loadEventFired. Douyin hydrates its feed asynchronously, so this is not padding." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					landedUrl: { type: "string" },
					pageTitle: { type: "string" },
					count: { type: "integer" },
					items: { type: "array", items: DOUYIN_CARD_SCHEMA },
					video: {
						type: "object",
						additionalProperties: false,
						properties: {
							videoId: { type: "string" },
							url: { type: "string" },
							caption: { type: "string" },
							author: { type: "string" },
							publishedAt: { type: "string" },
							likes: { type: "string" },
							commentsCount: { type: "string" },
							favorites: { type: "string" },
							shares: { type: "string" },
							videoSrc: { type: "string" },
							comments: { type: "array", items: { type: "string" } },
						},
					},
					rawText: { type: "string" },
					loginWall: { type: "boolean" },
					loggedIn: { type: "boolean" },
					browserRunning: { type: "boolean" },
					userDataDir: { type: "string" },
					note: { type: "string" },
				},
			},
			render: (_args, value) => text([
				`douyin ${value.action}${value.count ? ` — ${value.count} card(s)` : ""}`,
				lines([
					["landed", value.landedUrl],
					["title", value.pageTitle],
					["browser", `${value.browserRunning ? "running" : "stopped"}${value.userDataDir ? ` · profile ${value.userDataDir}` : ""}`],
				]),
				...value.items.slice(0, 40).map((card) => [
					`${card.rank > 0 ? `${card.rank}. ` : ""}${card.caption || card.id}`,
					`   ${card.id}${card.author ? ` · @${card.author}` : ""}${card.duration ? ` · ${card.duration}` : ""}${card.plays ? ` · ${card.plays} plays` : ""}${card.date ? ` · ${card.date}` : ""}`,
					`   ${card.url}`,
				].join("\n")),
				value.video
					? [
						`\ncaption: ${value.video.caption}`,
						lines([
							["author", value.video.author],
							["published", value.video.publishedAt],
							["counts", [value.video.likes, value.video.commentsCount, value.video.favorites, value.video.shares].filter(Boolean).join(" / ")],
							["url", value.video.url],
						]),
						value.video.comments.length > 0 ? `\ncomments:\n${value.video.comments.slice(0, 20).map((entry) => `  ${entry}`).join("\n")}` : "",
					].filter(Boolean).join("\n")
					: "",
				value.rawText ? `\nraw text (${value.rawText.length} chars):\n${value.rawText.slice(0, 2000)}` : "",
				`\n${value.note}`,
			].filter((line) => line !== "").join("\n")),
			presentationMeta: (_args, value) => ({
				card: "generic",
				title: `Douyin ${value.action}${value.count ? ` — ${value.count} cards` : ""}`,
				kind: "search",
			}),
		},
		timeoutMs: 180000,
		// The browser is a single shared session; two concurrent navigations would
		// fight over the same page target.
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const action = str(args.action);
			const waitMs = int(args.waitMs) > 0 ? int(args.waitMs) : limits().douyinWait;
			const base = {
				action,
				landedUrl: "",
				pageTitle: "",
				count: 0,
				items: [],
				loginWall: false,
				loggedIn: false,
				browserRunning: douyin.browser.running === true,
				userDataDir: str(douyin.browser.userDataDir),
				note: "",
			};

			if (action === "close") {
				douyin.close();
				return { ...base, browserRunning: false, note: "the helper browser profile was closed; signing in again is not needed, the profile keeps the session." };
			}

			if (action === "status") {
				const live = await douyin.status();
				return {
					...base,
					loggedIn: live.loggedIn === true,
					browserRunning: live.browserRunning === true,
					note: live.reachable
						? "the helper browser answers CDP."
						: `the helper browser did not answer: ${str(live.error?.code)} ${str(live.error?.message)}`,
				};
			}

			if (action === "hot" || action === "feed") {
				const board = await douyin.hot({ limit: Math.max(1, Math.min(60, int(args.limit) || 30)), waitMs, signal: exec.signal });
				return {
					...base,
					landedUrl: str(board.landedUrl),
					pageTitle: str(board.pageTitle),
					count: int(board.count),
					items: (Array.isArray(board.items) ? board.items : []).map((card) => ({
						rank: int(card.rank),
						id: str(card.id),
						url: str(card.url),
						caption: str(card.caption),
						author: str(card.author),
						date: str(card.date),
						duration: str(card.duration),
						plays: str(card.plays),
						cover: str(card.cover),
					})),
					note: str(board.note),
				};
			}

			if (action === "video") {
				if (!args.ref) throw new Error("whale_dive_douyin: `ref` is required for action `video`");
				const detail = await douyin.video(args.ref, {
					commentLimit: Math.max(1, Math.min(200, int(args.commentLimit) || 30)),
					waitMs,
					signal: exec.signal,
				});
				const stats = detail.stats ?? {};
				return {
					...base,
					landedUrl: str(detail.url),
					count: int(Array.isArray(detail.related) ? detail.related.length : 0),
					items: (Array.isArray(detail.related) ? detail.related : []).map((card, index) => ({
						rank: index + 1,
						id: str(card.id),
						url: str(card.url),
						caption: str(card.caption),
						author: str(card.author),
						date: str(card.date),
						duration: str(card.duration),
						plays: str(card.plays),
						cover: "",
					})),
					video: {
						videoId: str(detail.videoId),
						url: str(detail.url),
						caption: str(detail.caption),
						author: str(detail.author),
						publishedAt: str(detail.publishedAt),
						likes: str(stats.like),
						commentsCount: str(stats.comment),
						favorites: str(stats.favorite),
						shares: str(stats.share),
						videoSrc: str(detail.videoSrc).slice(0, 400),
						comments: (Array.isArray(detail.comments) ? detail.comments : []).map((entry) => str(entry).slice(0, 300)).slice(0, 60),
					},
					...(args.includeRawText === true ? { rawText: str(detail.rawText).slice(0, 8000) } : {}),
					note: `${str(detail.note)} The video element's src is the player's placeholder clip, not the media stream.`,
				};
			}

			if (action === "search") {
				if (!args.keyword) throw new Error("whale_dive_douyin: `keyword` is required for action `search`");
				const found = await douyin.search(args.keyword, { waitMs, signal: exec.signal });
				return {
					...base,
					landedUrl: str(found.landedUrl),
					pageTitle: str(found.pageTitle),
					loginWall: found.loginWall === true,
					count: int(found.count),
					items: (Array.isArray(found.items) ? found.items : []).map((card, index) => ({
						rank: index + 1,
						id: str(card.id),
						url: str(card.url),
						caption: str(card.caption),
						author: str(card.author),
						date: str(card.date),
						duration: str(card.duration),
						plays: str(card.plays),
						cover: "",
					})),
					note: str(found.note),
				};
			}

			throw new Error(`whale_dive_douyin: unknown action "${action}"`);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Douyin ${args.action}${args.keyword ? ` "${args.keyword}"` : ""}${args.ref ? ` ${args.ref}` : ""}`,
			kind: "search",
			rawInput: args.keyword ?? args.ref ?? args.action,
		}),
	});

	return [statusTool, videoTool, feedTool, searchTool, authorTool, commentsTool, danmakuTool, subtitlesTool, douyinTool];
}
