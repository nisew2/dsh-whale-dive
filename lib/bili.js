import { HttpClient, HttpError, DEFAULT_USER_AGENT, describeError } from "./http.js";
import { WbiSigner, keyFromUrl } from "./wbi.js";

/** Bilibili's public web API host. */
export const API_HOST = "https://api.bilibili.com";
/** The origin used for `Referer`, which several routes weakly require. */
export const WEB_ORIGIN = "https://www.bilibili.com";

/**
 * Routes observed live on 2026-10-16. Anything absent here is deliberately not
 * offered — a route that was never verified would just produce confusing errors.
 */
export const ROUTES = Object.freeze({
	view: "/x/web-interface/view",
	popular: "/x/web-interface/popular",
	pagelist: "/x/player/pagelist",
	playerV2: "/x/player/v2",
	related: "/x/web-interface/archive/related",
	reply: "/x/v2/reply",
	tags: "/x/tag/archive/tags",
	desc: "/x/web-interface/archive/desc",
	searchAll: "/x/web-interface/search/all/v2",
	searchType: "/x/web-interface/wbi/search/type",
	spaceInfo: "/x/space/wbi/acc/info",
	spaceVideos: "/x/space/wbi/arc/search",
	card: "/x/web-interface/card",
	recArchives: "/x/series/recArchivesByKeywords",
	relationStat: "/x/relation/stat",
	danmaku: "/x/v1/dm/list.so",
	nav: "/x/web-interface/nav",
});

/**
 * Strip Bilibili's search highlight markup (`<em class="keyword">…</em>`) and
 * decode the handful of entities that appear in titles and descriptions.
 *
 * @param value - raw field, possibly containing markup.
 * @returns plain text.
 */
export function stripHighlight(value) {
	if (typeof value !== "string") return value ?? "";
	return value
		.replace(/<\/?em\b[^>]*>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;|&ensp;|&emsp;/g, " ")
		.replace(/&amp;/g, "&")
		.trim();
}

/** Render seconds as `H:MM:SS` / `M:SS`, for durations in model-facing text. */
export function formatDuration(seconds) {
	const total = Math.max(0, Math.floor(Number(seconds) || 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parse a `BV…`/`av…` reference, a bare number, or a bilibili URL into ids. */
export function parseVideoRef(input) {
	const text = String(input ?? "").trim();
	if (text.length === 0) throw new HttpError("a video reference is required", { code: "INVALID_ARGS" });
	const bv = text.match(/BV[0-9A-Za-z]{8,12}/);
	if (bv) return { bvid: bv[0] };
	const av = text.match(/(?:^|[^0-9])av(\d{3,})/i) ?? text.match(/^(\d{6,})$/);
	if (av) return { aid: Number(av[1]) };
	throw new HttpError(
		`could not read a video id from "${text}" — pass a bvid (BV1xx411c7mD), an aid, or a bilibili video URL`,
		{ code: "INVALID_ARGS" },
	);
}

/**
 * Format one `stat` block the way the tools report it.
 *
 * @param stat - the `stat` object from `view` or `popular`.
 * @returns `{ view, danmaku, reply, like, coin, favorite, share }`, numbers only.
 */
export function readStat(stat = {}) {
	const pick = (key) => Number(stat?.[key] ?? 0);
	return {
		view: pick("view"),
		danmaku: pick("danmaku"),
		reply: pick("reply"),
		like: pick("like"),
		coin: pick("coin"),
		favorite: pick("favorite"),
		share: pick("share"),
	};
}

/**
 * Client-fingerprint parameters the site's own frontend attaches to the
 * `space/wbi/*` group.
 *
 * These are not decoration. Measured against `x/space/wbi/acc/info` with a valid
 * WBI signature and no cookie, twelve calls each way: without these fields the
 * route answered `-352` (风控校验失败) on eleven calls and `0` on one; with them
 * it answered `0` on all twelve. The values are base64 of the WebGL vendor and
 * renderer strings a desktop browser reports — the upstream checks that the
 * caller looks like a browser, not that the strings match any particular GPU,
 * so plausible values are enough and nothing here is machine-specific.
 */
export const CLIENT_HINTS = Object.freeze({
	dm_img_list: "[]",
	dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
	dm_cover_img_str:
		"QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgUlRYIDQwNjAgTGFwdG9wIEdQVSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKQ",
	dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
});

/**
 * Flatten the two profile shapes into one record the tools can report.
 *
 * `card` and `space/wbi/acc/info` disagree on where the level and the like count
 * live — the former nests `level_info.current_level` and puts the total likes on
 * the envelope, the latter reports `level` and `likes` inline. Folding both here
 * is what lets {@link BiliClient.userInfo} swap routes without the caller caring.
 *
 * @param card - the `card` object, or the signed route's `data`.
 * @param meta - `mid` plus whichever counters this route happened to carry.
 * @param source - `"card"` or `"signed"`, reported so a caller can tell them apart.
 * @returns `{ mid, name, sign, face, level, likes, archiveCount, source }`.
 */
function normalizeProfile(card, meta, source) {
	const level = card?.level_info?.current_level ?? card?.level ?? 0;
	return {
		mid: Number(meta?.mid ?? card?.mid ?? 0),
		name: String(card?.name ?? ""),
		sign: String(card?.sign ?? ""),
		face: String(card?.face ?? ""),
		level: Number(level) || 0,
		likes: Number(meta?.likes ?? card?.likes ?? card?.like_num ?? 0) || 0,
		archiveCount: Number(meta?.archiveCount ?? card?.archive_count ?? 0) || 0,
		source: String(source),
	};
}

/**
 * The Bilibili read client: one pacer, one signer, one pacing budget per plugin load.
 */
export class BiliClient {
	/**
	 * @param options - `pacerOptions`, `timeoutMs`, `userAgent`, `cookie` (optional SESSDATA
	 *   string, forwarded as the `Cookie` header when the user supplied one).
	 */
	constructor(options = {}) {
		this.http = new HttpClient({
			pacer: options.pacer,
			pacerOptions: options.pacerOptions,
			timeoutMs: options.timeoutMs,
			userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
			headers: {
				referer: `${WEB_ORIGIN}/`,
				origin: WEB_ORIGIN,
				...(options.cookie ? { cookie: options.cookie } : {}),
			},
		});
		this.cookie = options.cookie ?? "";
		this.signer = new WbiSigner({
			fetchKeys: async () => {
				const data = await this.http.api(`${API_HOST}${ROUTES.nav}`, {
					allowCodes: [-101],
					label: "GET /x/web-interface/nav",
				});
				const wbi = data?.wbi_img;
				if (!wbi?.img_url || !wbi?.sub_url) {
					throw new HttpError("nav did not return a wbi_img (img_url/sub_url); the WBI route may have changed", {
						code: "PARSE",
						url: `${API_HOST}${ROUTES.nav}`,
					});
				}
				return { imgKey: keyFromUrl(wbi.img_url), subKey: keyFromUrl(wbi.sub_url) };
			},
		});
	}

	/** Whether a cookie was configured; subtitle and space routes depend on it. */
	get hasCookie() {
		return this.cookie.length > 0;
	}

	/** `view` — the full metadata record for one video. */
	async video(ref, options = {}) {
		const ids = typeof ref === "string" ? parseVideoRef(ref) : ref;
		return this.http.getJson(`${API_HOST}${ROUTES.view}`, { ...ids }, { signal: options.signal, label: "GET view" });
	}

	/** `popular` — the front-page recommendation feed. */
	async popular({ page = 1, pageSize = 20, signal } = {}) {
		return this.http.getJson(
			`${API_HOST}${ROUTES.popular}`,
			{ ps: pageSize, pn: page },
			{ signal, label: "GET popular" },
		);
	}

	/** `pagelist` — the parts of a multi-part video. */
	async pages(ref, { signal } = {}) {
		const ids = typeof ref === "string" ? parseVideoRef(ref) : ref;
		return this.http.getJson(`${API_HOST}${ROUTES.pagelist}`, { ...ids }, { signal, label: "GET pagelist" });
	}

	/** `player/v2` — player metadata, including whether subtitles need a login. */
	async player(bvid, cid, { signal } = {}) {
		return this.http.getJson(
			`${API_HOST}${ROUTES.playerV2}`,
			{ bvid, cid },
			{ signal, label: "GET player/v2" },
		);
	}

	/** `archive/related` — up to 40 related videos. */
	async related(ref, { signal } = {}) {
		const ids = typeof ref === "string" ? parseVideoRef(ref) : ref;
		return this.http.getJson(`${API_HOST}${ROUTES.related}`, { ...ids }, { signal, label: "GET related" });
	}

	/** `reply` — the comment page for a video (`type=1`, keyed by aid). */
	async comments(aid, { page = 1, pageSize = 20, sort = 2, signal } = {}) {
		return this.http.getJson(
			`${API_HOST}${ROUTES.reply}`,
			{ type: 1, oid: aid, ps: pageSize, pn: page, sort },
			{ signal, label: "GET reply" },
		);
	}

	/** `tag/archive/tags` — the tag list attached to a video. */
	async tags(ref, { signal } = {}) {
		const ids = typeof ref === "string" ? parseVideoRef(ref) : ref;
		return this.http.getJson(`${API_HOST}${ROUTES.tags}`, { ...ids }, { signal, label: "GET tags" });
	}

	/** Signed `wbi/search/type` — keyword search restricted to `search_type`. */
	async search(keyword, { type = "video", page = 1, pageSize = 20, order, signal } = {}) {
		const params = { search_type: type, keyword, page, page_size: pageSize };
		if (order) params.order = order;
		const signed = await this.signer.sign(params, { signal });
		return this.http.getJson(`${API_HOST}${ROUTES.searchType}`, signed, { signal, label: "GET wbi/search/type" });
	}

	/** Unsigned `search/all/v2` — grouped results across every search vertical. */
	async searchAll(keyword, { page = 1, signal } = {}) {
		return this.http.getJson(
			`${API_HOST}${ROUTES.searchAll}`,
			{ keyword, page },
			{ signal, label: "GET search/all/v2" },
		);
	}

	/**
	 * `web-interface/card` — the unsigned profile route, and the primary one.
	 *
	 * Measured on the same IP, same minute: this route answered `code: 0` on all
	 * twelve calls, while the signed `space/wbi/acc/info` answered `-352` on
	 * eleven of twelve. Both carry name/sign/face/level; only this one also
	 * carries the total like count. It is picked first for that reason, and the
	 * signed route stays as the fallback.
	 */
	async card(mid, { signal } = {}) {
		const data = await this.http.getJson(
			`${API_HOST}${ROUTES.card}`,
			{ mid, photo: true },
			{ signal, label: "GET web-interface/card" },
		);
		const card = data?.card ?? {};
		return normalizeProfile(card, { mid, likes: data?.like_num, archiveCount: data?.archive_count }, "card");
	}

	/**
	 * A user's profile, from the unsigned card route with the signed one behind it.
	 *
	 * The signed route is the single most risk-controlled endpoint on the API, so
	 * it is only consulted when the unsigned one is itself being throttled.
	 */
	async userInfo(mid, { signal } = {}) {
		try {
			return await this.card(mid, { signal });
		} catch (error) {
			if (!(error instanceof HttpError) || error.risk !== true) throw error;
			const signed = await this.signer.sign({ mid, ...CLIENT_HINTS }, { signal });
			const data = await this.http.getJson(`${API_HOST}${ROUTES.spaceInfo}`, signed, {
				signal,
				label: "GET space/acc/info",
			});
			return normalizeProfile(
				{ ...data, level_info: { current_level: data?.level } },
				{ mid, likes: data?.likes },
				"signed",
			);
		}
	}

	/**
	 * `series/recArchivesByKeywords` — an unsigned upload list.
	 *
	 * It reports the item id, title, cover, duration, publish time, description
	 * and a view count, and pages with `ps`/`pn`. What it does not carry is the
	 * `order` control or the per-item danmaku/like/coin counters, so the signed
	 * `space/wbi/arc/search` is preferred whenever a non-default order is asked
	 * for and used as the fallback otherwise.
	 */
	async recArchives(mid, { page = 1, pageSize = 20, signal } = {}) {
		const data = await this.http.getJson(
			`${API_HOST}${ROUTES.recArchives}`,
			{ mid, keywords: "", ps: pageSize, pn: page },
			{ signal, label: "GET series/recArchivesByKeywords" },
		);
		const rows = Array.isArray(data?.archives) ? data.archives : [];
		return {
			items: rows.map((entry) => ({ ...entry, owner: { mid } })),
			page: Number(data?.page?.num ?? page),
			total: Number(data?.page?.total ?? rows.length),
			source: "recArchives",
		};
	}

	/** Signed `space/wbi/arc/search` — a user's upload list, with ordering. */
	async spaceVideos(mid, { page = 1, pageSize = 20, order = "pubdate", signal } = {}) {
		const signed = await this.signer.sign(
			{ mid, ps: pageSize, pn: page, order, platform: "web", web_location: 1550101, ...CLIENT_HINTS },
			{ signal },
		);
		const data = await this.http.getJson(`${API_HOST}${ROUTES.spaceVideos}`, signed, {
			signal,
			label: "GET space/arc/search",
		});
		const rows = Array.isArray(data?.list?.vlist) ? data.list.vlist : [];
		return {
			items: rows.map((entry) => ({ ...entry, owner: { mid, name: entry.author } })),
			page: Number(data?.page?.pn ?? page),
			total: Number(data?.page?.count ?? rows.length),
			source: "signed",
		};
	}

	/**
	 * A user's upload list: unsigned when the default ordering is acceptable,
	 * signed when it is not, with the other route as the fallback either way.
	 */
	async userVideos(mid, { page = 1, pageSize = 20, order = "pubdate", signal } = {}) {
		const signedFirst = order !== "pubdate";
		const attempt = (source) => (source === "signed"
			? this.spaceVideos(mid, { page, pageSize, order, signal })
			: this.recArchives(mid, { page, pageSize, signal }));
		const order_ = signedFirst ? ["signed", "recArchives"] : ["recArchives", "signed"];
		let lastError;
		for (const source of order_) {
			try {
				return await attempt(source);
			} catch (error) {
				if (!(error instanceof HttpError) || error.risk !== true) throw error;
				lastError = error;
			}
		}
		throw lastError;
	}

	/** `relation/stat` — a user's follower/following counts. */
	async relation(mid, { signal } = {}) {
		return this.http.getJson(`${API_HOST}${ROUTES.relationStat}`, { vmid: mid }, { signal, label: "GET relation/stat" });
	}

	/** Fetch the subtitle list for a video and report honestly what is gated. */
	async subtitles(bvid, cid, { signal } = {}) {
		const view = await this.video(bvid, { signal });
		const parts = view?.pages?.length ? view.pages : [];
		const targets = cid ? [{ cid, part: parts.find((p) => p.cid === cid)?.part ?? "" }] : parts.length
			? parts.map((p) => ({ cid: p.cid, part: p.part }))
			: [{ cid: view?.cid, part: "" }];
		const results = [];
		for (const target of targets.slice(0, 8)) {
			const player = await this.player(bvid, target.cid, { signal });
			const list = player?.subtitle?.subtitles ?? [];
			results.push({
				cid: target.cid,
				part: target.part,
				needLogin: player?.need_login_subtitle === true,
				tracks: list.map((t) => ({
					lan: t.lan,
					lanDoc: t.lan_doc,
					locked: t.is_lock === true,
					url: t.subtitle_url ?? "",
					author: t.author?.name ?? "",
				})),
			});
		}
		const viewList = view?.subtitle?.list ?? [];
		const anyUrl = results.some((r) => r.tracks.some((t) => t.url.length > 0));
		return {
			bvid,
			aid: view?.aid,
			title: view?.title ?? "",
			needLogin: results.some((r) => r.needLogin) || (!anyUrl && viewList.length > 0),
			available: anyUrl,
			parts: results,
			viewTracks: viewList.map((t) => ({ lan: t.lan, lanDoc: t.lan_doc, url: t.subtitle_url ?? "" })),
			note: anyUrl
				? "subtitle bodies are reachable with the configured cookie"
				: "subtitle bodies are login-gated: every subtitle_url came back empty. Supply a SESSDATA cookie in the plugin config to read them.",
		};
	}

	/** Fetch a subtitle body by absolute URL, returning cue rows. */
	async subtitleBody(url, { signal } = {}) {
		const response = await this.http.getText(url, { signal, label: "GET subtitle json" });
		let parsed;
		try {
			parsed = JSON.parse(response.text);
		} catch {
			throw new HttpError(`subtitle body at ${new URL(url).host} was not JSON`, {
				code: "PARSE",
				status: response.status,
				url,
				body: response.text.slice(0, 200),
			});
		}
		const body = parsed?.body ?? parsed?.subtitles ?? [];
		return body.map((cue) => ({
			from: Number(cue.from ?? 0),
			to: Number(cue.to ?? 0),
			text: String(cue.content ?? cue.text ?? "").trim(),
		}));
	}

	/** Fetch and parse the danmaku XML for one part. */
	async danmaku(cid, { limit = 500, signal } = {}) {
		const response = await this.http.getText(`${API_HOST}${ROUTES.danmaku}?oid=${cid}`, {
			signal,
			label: "GET dm/list.so",
		});
		const rows = [];
		const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
		let match;
		while ((match = re.exec(response.text)) !== null && rows.length < limit) {
			const attrs = match[1].split(",");
			rows.push({
				text: match[2]
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"')
					.replace(/&#39;/g, "'")
					.replace(/&amp;/g, "&")
					.trim(),
				timeMs: Math.round(Number(attrs[0] ?? 0) * 1000),
				mode: Number(attrs[1] ?? 1),
				fontSize: Number(attrs[2] ?? 25),
				color: Number(attrs[3] ?? 16777215),
				sentAt: Number(attrs[4] ?? 0),
				pool: Number(attrs[5] ?? 0),
				senderHash: attrs[6] ?? "",
			});
		}
		return { cid, total: rows.length, truncated: rows.length >= limit, rows };
	}

	/** Pacer + request counters, surfaced by `whale_dive_status`. */
	status() {
		return {
			...this.http.status(),
			cookie: this.hasCookie ? "configured" : "absent",
			wbiKeyMsRemaining: this.signer.expiresInMs,
		};
	}
}

export { describeError, HttpError };
