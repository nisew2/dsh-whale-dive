/**
 * Type declarations for `dsh-whale-dive`.
 *
 * The plugin registers tools through Cordis rather than exporting a callable
 * surface, so the useful declarations are the config shape and the two backend
 * classes an embedder may want to drive directly.
 *
 * @module dsh-whale-dive
 */

/** Cordis plugin name. */
export declare const name: "whale-dive";

/** Services this plugin requires. */
export declare const inject: readonly string[];

/** Resolved plugin configuration. */
export interface WhaleDiveConfig {
	/** Requests per second allowed per host, shared by every Bilibili tool. */
	requestsPerSecond: number;
	/** Token-bucket capacity — how much idle time can be spent at once. */
	burst: number;
	/** Maximum requests in flight at one time. */
	maxConcurrent: number;
	/** How long one risk signal parks a host, in ms. Doubles per consecutive trip. */
	cooldownMs: number;
	/** Ceiling for the doubling cool-down, in ms. */
	maxCooldownMs: number;
	/** Per-request timeout in ms. */
	timeoutMs: number;
	/** A `SESSDATA=...` (or full) cookie string, sent with Bilibili requests. */
	cookie: string;
	/** Explicit path to a CDP-capable browser; empty auto-detects Edge then Chrome. */
	douyinBrowser: string;
	/** DevTools port the helper browser listens on. */
	douyinPort: number;
	/** Profile directory for the helper browser; empty uses a temp directory. */
	douyinUserDataDir: string;
	/** How long an idle helper browser stays alive, in ms. */
	douyinKeepAliveMs: number;
	/** Default settle time after `loadEventFired` on a Douyin page, in ms. */
	douyinWaitMs: number;
	/** Default cap on danmaku rows returned by `whale_dive_bili_danmaku`. */
	danmakuLimit: number;
	/** Default comment page size. */
	commentPageSize: number;
}

/** The schema object the loader instantiates per profile. */
export declare const Config: {
	new (): WhaleDiveConfig;
	(value: Partial<WhaleDiveConfig>): WhaleDiveConfig;
};

/** Cordis entry point. */
export declare function apply(ctx: unknown, config: WhaleDiveConfig): void;

/** Typed failure carrying enough structure to decide retry versus stop. */
export declare class HttpError extends Error {
	code: string;
	url?: string;
	status?: number;
	upstreamCode?: number;
	risk: boolean;
	retryAfterMs: number;
	body?: unknown;
}

/** Project a thrown value into `{ code, message }`. */
export declare function describeError(error: unknown): { code: string; message: string };

/** Pacer snapshot, as surfaced by `whale_dive_status`. */
export interface PacerSnapshot {
	requests: number;
	riskSignals: number;
	dispatched: number;
	blocked: number;
	inflight: number;
	queued: number;
	requestsPerSecond: number;
	burst: number;
	maxConcurrent: number;
	hosts: Record<
		string,
		{
			tokens: number;
			coolingDown: boolean;
			cooldownRemainingMs: number;
			trips: number;
			lastReason: string;
		}
	>;
}

/** Normalized uploader profile. */
export interface BiliProfile {
	mid: number;
	name: string;
	sign: string;
	face: string;
	level: number;
	likes: number;
	archiveCount: number;
	source: string;
}

/** The paced Bilibili client. */
export declare class BiliClient {
	constructor(options?: {
		pacerOptions?: Partial<{
			requestsPerSecond: number;
			burst: number;
			maxConcurrent: number;
			cooldownMs: number;
			maxCooldownMs: number;
		}>;
		timeoutMs?: number;
		cookie?: string;
	});
	video(ref: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
	popular(options?: { page?: number; pageSize?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>;
	related(bvid: string, options?: { signal?: AbortSignal }): Promise<unknown[]>;
	search(keyword: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
	card(mid: number, options?: { signal?: AbortSignal }): Promise<BiliProfile>;
	userInfo(mid: number, options?: { signal?: AbortSignal }): Promise<BiliProfile>;
	relation(mid: number, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
	recArchives(mid: number, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
	spaceVideos(mid: number, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
	userVideos(mid: number, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
	comments(aid: number, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
	player(bvid: string, cid: number, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
	subtitles(bvid: string, cid?: number, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
	subtitleBody(url: string, options?: { signal?: AbortSignal }): Promise<Array<{ from: number; to: number; text: string }>>;
	danmaku(cid: number, options?: { limit?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>;
	status(): PacerSnapshot & { cookie: string; wbiKeyMsRemaining: number };
}

/** A lazily-started Edge/Chrome that the Douyin reader drives over CDP. */
export declare class DouyinBrowser {
	constructor(options?: {
		browserPath?: string;
		port?: number;
		userDataDir?: string;
		keepAliveMs?: number;
		headless?: boolean;
	});
	readonly running: boolean;
	readonly port: number;
	readonly userDataDir: string;
	ensureSession(options?: { timeoutMs?: number }): Promise<unknown>;
	goto(url: string, options?: { waitMs?: number; timeoutMs?: number }): Promise<unknown>;
	hasLogin(timeoutMs?: number): Promise<boolean>;
	close(): void;
}

/** The DOM-reading Douyin facade. */
export declare class DouyinReader {
	constructor(options?: { browser?: DouyinBrowser; waitMs?: number });
	hot(options?: { limit?: number; waitMs?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>;
	video(
		ref: string,
		options?: { waitMs?: number; commentLimit?: number; signal?: AbortSignal },
	): Promise<Record<string, unknown>>;
	search(keyword: string, options?: { waitMs?: number; signal?: AbortSignal }): Promise<Record<string, unknown>>;
	login(options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
	status(): Promise<Record<string, unknown>>;
	close(): void;
}

/** Locate a CDP-capable browser binary, or throw. */
export declare function findBrowser(explicit?: string): string;

/** Normalize a Douyin video reference (id, URL, or short link). */
export declare function parseDouyinRef(input: string): { id?: string; url: string };

/** Split a Douyin card's flattened inner text into structured fields. */
export declare function parseCardText(card: { text?: string; alt?: string }): {
	duration: string;
	plays: string;
	author: string;
	date: string;
	caption: string;
};
