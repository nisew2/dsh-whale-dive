/**
 * `dsh-whale-dive` — read Bilibili and Douyin from inside DSH.
 *
 * The plugin owns two independent read paths and exposes them as one family of
 * tools:
 *
 *   * **Bilibili** goes over its public web API with a paced HTTP client, a
 *     rotating-key WBI signer, and a per-host circuit breaker. The pacing is
 *     not decoration: the interface route group answers a sustained burst of
 *     ~50 req/s with an IP-scoped HTTP 412 that outlives the burst by minutes,
 *     so the pacer's job is to keep the caller inside the ~4 req/s band the
 *     route tolerates and to fail fast and legibly once a risk signal arrives.
 *   * **Douyin** cannot be read over HTTP at all — it signs its API calls with
 *     `a_bogus`/`X-Bogus` computed inside an obfuscated VM and answers plain
 *     clients with 403s and empty bodies. The plugin therefore drives a real
 *     Edge/Chrome over the DevTools protocol, in its own profile directory,
 *     and reads the rendered DOM.
 *
 * Both paths are read-only and both report their gates honestly rather than
 * substituting an error for an answer the caller could act on.
 *
 * @module dsh-whale-dive
 */
import z from "@deepseek-ai/schemastery";
import { BiliClient } from "./bili.js";
import { DouyinBrowser, DouyinReader } from "./douyin.js";
import { createTools } from "./tools.js";

/** Cordis plugin name. */
const name = "whale-dive";

/**
 * Services this plugin requires. `tools` is the only hard dependency; the
 * system-prompt section below attaches only when that service exists.
 */
const inject = ["tools"];

/** Order slot for the guidance section, after the built-in tool sections. */
const SECTION_ORDER = 2400;

/**
 * Plugin configuration.
 *
 * Every field is a live value: the tools read `config()` on each call, so an
 * edit through the settings UI takes effect on the next tool call without a
 * reload.
 */
const Config = z.object({
	/** Requests per second allowed per host, shared by every bili tool. */
	requestsPerSecond: z.number().default(4),
	/** Token-bucket capacity — how much idle time can be spent at once. */
	burst: z.number().default(8),
	/** Maximum requests in flight at one time. */
	maxConcurrent: z.number().default(3),
	/** How long one risk signal parks a host, in ms. Doubles per consecutive trip. */
	cooldownMs: z.number().default(120000),
	/** Ceiling for the doubling cool-down, in ms. */
	maxCooldownMs: z.number().default(600000),
	/** Per-request timeout in ms. */
	timeoutMs: z.number().default(20000),
	/**
	 * A `SESSDATA=...` (or full) cookie string, sent with Bilibili requests.
	 * Without it the subtitle bodies stay unreadable and a few routes answer
	 * `-101`; with it those routes work. Absent by default — nothing here needs
	 * a login to read public pages.
	 */
	cookie: z.string().default(""),
	/** Explicit path to a CDP-capable browser; empty auto-detects Edge then Chrome. */
	douyinBrowser: z.string().default(""),
	/** DevTools port the helper browser listens on. */
	douyinPort: z.number().default(47821),
	/** Profile directory for the helper browser; empty uses a temp directory. */
	douyinUserDataDir: z.string().default(""),
	/** How long an idle helper browser stays alive, in ms. */
	douyinKeepAliveMs: z.number().default(900000),
	/** Default settle time after `loadEventFired` on a Douyin page, in ms. */
	douyinWaitMs: z.number().default(11000),
	/** Default cap on danmaku rows returned by `whale_dive_bili_danmaku`. */
	danmakuLimit: z.number().default(500),
	/** Default comment page size. */
	commentPageSize: z.number().default(20),
});

/** Build the two backends once per activation, sharing one pacer budget. */
function createBackends(readConfig) {
	const settings = readConfig();
	const bili = new BiliClient({
		pacerOptions: {
			requestsPerSecond: settings.requestsPerSecond,
			burst: settings.burst,
			maxConcurrent: settings.maxConcurrent,
			cooldownMs: settings.cooldownMs,
			maxCooldownMs: settings.maxCooldownMs,
		},
		timeoutMs: settings.timeoutMs,
		cookie: settings.cookie || undefined,
	});
	const browser = new DouyinBrowser({
		browserPath: settings.douyinBrowser || undefined,
		port: settings.douyinPort,
		userDataDir: settings.douyinUserDataDir || undefined,
		keepAliveMs: settings.douyinKeepAliveMs,
	});
	const douyin = new DouyinReader({ browser, waitMs: settings.douyinWaitMs });
	return { bili, douyin };
}

/**
 * Plugin entry point.
 *
 * @param ctx - the Cordis context; `ctx.tools` is already present.
 * @param config - the resolved {@link Config} instance.
 */
function apply(ctx, config) {
	// The loader hot-commits config edits into the running fiber, so the config
	// object is read through a getter on every call rather than captured.
	const readConfig = () => config ?? {};
	const { bili, douyin } = createBackends(readConfig);

	for (const tool of createTools({ bili, douyin, config: readConfig })) {
		ctx.tools.register(tool);
	}

	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.systemPrompt.section({
			name: "tool:whale_dive",
			order: SECTION_ORDER,
			text: () =>
				"whale_dive_* tools read Bilibili and Douyin. Bilibili reads are rate limited on purpose: keep calls sequential, prefer one aggregated call over a loop of narrow ones, and when a call reports a cool-down, stop calling that host until the window expires rather than retrying. Douyin reads drive a real browser and each one costs several seconds; `whale_dive_douyin` with action `hot` is the only keyword-free surface, keyword search needs a one-time sign-in in the plugin's own browser profile.",
		});
	});

	// Stop the helper browser when the plugin unloads, so a reload does not
	// leave an orphaned Edge process behind.
	ctx.effect(() => () => douyin.close());
}

export { Config, apply, inject, name };
