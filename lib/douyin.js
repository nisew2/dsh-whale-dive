import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpClient, HttpError, describeError } from "./http.js";

/** Edge and Chrome locations this module probes, in order. */
const BROWSER_CANDIDATES = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** Chrome DevTools flags that keep the window out of the way and off the network's back. */
const BASE_FLAGS = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-sync",
	"--disable-extensions",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-features=Translate,OptimizationHints",
	// The window is parked off-screen so it never steals focus, and Chrome
	// throttles rendering for windows it believes are occluded. Without these
	// three flags the parked window paints nothing, the feed never hydrates, and
	// the DOM this module reads stays empty.
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--disable-background-timer-throttling",
	"--window-size=1440,900",
	"--window-position=-32000,-32000",
	"--mute-audio",
];

/** Sleep helper, local so this module has no cycle with the limiter. */
const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new HttpError("aborted", { code: "ABORTED" }));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new HttpError("aborted", { code: "ABORTED" }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** Locate a CDP-capable browser binary. */
export function findBrowser(explicit) {
	if (explicit) {
		if (fs.existsSync(explicit)) return explicit;
		throw new HttpError(`the configured browser path does not exist: ${explicit}`, { code: "INVALID_ARGS" });
	}
	for (const candidate of BROWSER_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
	throw new HttpError(
		"no CDP-capable browser found. Install Microsoft Edge or Google Chrome, or set `douyinBrowser` to its full path.",
		{ code: "NO_BROWSER" },
	);
}

/**
 * A minimal Chrome DevTools Protocol session over a `page` target.
 *
 * Node 22+ ships a global `WebSocket`, so this needs no dependency.
 */
class CdpSession {
	/** @param webSocketUrl - the target's `webSocketDebuggerUrl`. */
	constructor(webSocketUrl) {
		this.url = webSocketUrl;
		this.seq = 0;
		this.pending = new Map();
	}

	async open({ timeoutMs = 20000 } = {}) {
		this.ws = new WebSocket(this.url);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new HttpError("CDP websocket did not open in time", { code: "CDP_TIMEOUT" })), timeoutMs);
			this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
			this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new HttpError("CDP websocket failed to connect", { code: "CDP_ERROR" })); }, { once: true });
		});
		this.ws.addEventListener("message", (event) => {
			let message;
			try { message = JSON.parse(event.data); } catch { return; }
			const slot = this.pending.get(message.id);
			if (!slot) return;
			this.pending.delete(message.id);
			message.error ? slot.reject(new HttpError(`CDP ${slot.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`, { code: "CDP_ERROR" })) : slot.resolve(message.result);
		});
		this.ws.addEventListener("close", () => {
			for (const slot of this.pending.values()) slot.reject(new HttpError("CDP websocket closed", { code: "CDP_CLOSED" }));
			this.pending.clear();
		});
	}

	/** Send one CDP command and await its result. */
	send(method, params = {}, timeoutMs = 40000) {
		return new Promise((resolve, reject) => {
			const id = ++this.seq;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new HttpError(`CDP ${method} timed out after ${timeoutMs}ms`, { code: "CDP_TIMEOUT" }));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: (value) => { clearTimeout(timer); resolve(value); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			});
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Evaluate an expression in the page and return its value by copy. */
	async evaluate(expression, { timeoutMs = 40000 } = {}) {
		const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
		if (result?.exceptionDetails) {
			throw new HttpError(
				`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`,
				{ code: "CDP_EVAL" },
			);
		}
		return result?.result?.value;
	}

	close() {
		try { this.ws?.close(); } catch { /* already gone */ }
		this.pending.clear();
	}
}

/**
 * A lazily-started Edge/Chrome that this plugin drives over CDP.
 *
 * The browser keeps its own profile directory so nothing here touches the user's
 * normal browser state, and it starts headfully (Douyin's bot checks reject
 * headless), positioned off-screen.
 */
export class DouyinBrowser {
	/**
	 * @param options - `browserPath`, `port`, `userDataDir`, `keepAliveMs`, `headless` (not
	 *   recommended: Douyin shows a captcha wall to headless agents).
	 */
	constructor(options = {}) {
		this.browserPath = options.browserPath || undefined;
		this.port = Number(options.port) || 47821;
		this.userDataDir = options.userDataDir || path.join(os.tmpdir(), "dsh-whale-dive-browser");
		this.keepAliveMs = Math.max(60000, Number(options.keepAliveMs) || 15 * 60 * 1000);
		this.headless = options.headless === true;
		this.child = undefined;
		this.session = undefined;
		this.lastUsedAt = 0;
		this.idleTimer = undefined;
	}

	get running() {
		return this.child !== undefined && this.child.exitCode === null;
	}

	/** Start the browser if it is not running, then return a live CDP session. */
	async ensureSession({ timeoutMs = 30000 } = {}) {
		this.touch();
		if (this.session && this.running) return this.session;
		if (this.running) {
			this.session = await this.attach(timeoutMs);
			return this.session;
		}
		const binary = findBrowser(this.browserPath);
		fs.mkdirSync(this.userDataDir, { recursive: true });
		const flags = [
			`--remote-debugging-port=${this.port}`,
			`--user-data-dir=${this.userDataDir}`,
			...BASE_FLAGS,
			...(this.headless ? ["--headless=new"] : []),
			"about:blank",
		];
		this.child = spawn(binary, flags, { detached: true, stdio: "ignore" });
		this.child.unref();
		this.child.on("exit", () => { this.child = undefined; this.session = undefined; });
		this.session = await this.attach(timeoutMs);
		return this.session;
	}

	/** Poll the debugging endpoint until it answers, then attach to the page target. */
	async attach(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		let lastError;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
				const targets = await response.json();
				const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
				if (page) {
					const session = new CdpSession(page.webSocketDebuggerUrl);
					await session.open({ timeoutMs: 10000 });
					await session.send("Page.enable");
					await session.send("Runtime.enable");
					await session.send("Network.enable");
					return session;
				}
			} catch (error) {
				lastError = error;
			}
			await sleep(300);
		}
		throw new HttpError(
			`CDP endpoint on 127.0.0.1:${this.port} never became ready within ${timeoutMs}ms` +
				(lastError ? ` (last error: ${lastError.message})` : ""),
			{ code: "CDP_TIMEOUT" },
		);
	}

	/** Navigate and wait for the page to settle. */
	async goto(url, { waitMs = 8000, timeoutMs = 45000 } = {}) {
		const session = await this.ensureSession({ timeoutMs });
		const settled = new Promise((resolve) => {
			const onMessage = (event) => {
				let message;
				try { message = JSON.parse(event.data); } catch { return; }
				if (message.method === "Page.loadEventFired") { clearTimeout(timer); session.ws.removeEventListener("message", onMessage); resolve(); }
			};
			session.ws.addEventListener("message", onMessage);
			const timer = setTimeout(() => { session.ws.removeEventListener("message", onMessage); resolve(); }, waitMs);
		});
		await session.send("Page.navigate", { url }, timeoutMs);
		await settled;
		// Douyin hydrates its feed asynchronously after loadEventFired; a flat settle pass
		// is what makes the DOM readable at all.
		await sleep(waitMs);
		return session;
	}

	/** Keep the browser alive for the configured window and schedule teardown. */
	touch() {
		this.lastUsedAt = Date.now();
		if (this.idleTimer) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (Date.now() - this.lastUsedAt >= this.keepAliveMs) this.close();
			else this.touch();
		}, this.keepAliveMs);
		this.idleTimer.unref?.();
	}

	/** Terminate the browser process group. */
	close() {
		if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
		const session = this.session;
		this.session = undefined;
		session?.close();
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null) {
			try { child.kill(); } catch { /* already gone */ }
			if (process.platform === "win32" && child.pid) {
				try {
					spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", detached: false });
				} catch { /* best effort */ }
			}
		}
	}

	/** Whether the browser's profile has a signed-in Douyin session. */
	async hasLogin(timeoutMs = 30000) {
		const session = await this.ensureSession({ timeoutMs });
		const state = await session.evaluate(
			"document.cookie.includes('sessionid') || document.cookie.includes('sid_tt')",
		);
		return state === true;
	}
}

/** Douyin surfaces this module reads, and the wait each one needs. */
export const DOUYIN_PAGES = Object.freeze({
	hot: { url: "https://www.douyin.com/hot", waitMs: 11000, loginRequired: false },
	feed: { url: "https://www.douyin.com/jingxuan", waitMs: 11000, loginRequired: false },
});

/** Normalize a Douyin video reference (id or URL) into a canonical URL. */
export function parseDouyinRef(input) {
	const text = String(input ?? "").trim();
	if (text.length === 0) throw new HttpError("a Douyin video reference is required", { code: "INVALID_ARGS" });
	const id = text.match(/(?:video|note)\/(\d{6,})/) ?? text.match(/^(\d{6,})$/);
	if (id) return { id: id[1], url: `https://www.douyin.com/video/${id[1]}` };
	const short = text.match(/v\.douyin\.com\/[A-Za-z0-9]+/);
	if (short) return { id: undefined, url: `https://${short[0]}` };
	throw new HttpError(`could not read a Douyin video id from "${input}"`, { code: "INVALID_ARGS" });
}

/** Extract the video cards currently rendered in the DOM. */
const EXTRACT_VIDEO_CARDS = `(() => {
	const seen = new Set();
	const cards = [];
	for (const anchor of document.querySelectorAll('a[href*="/video/"]')) {
		const href = anchor.getAttribute('href') || '';
		const idMatch = href.match(/\\/video\\/(\\d+)/);
		if (!idMatch) continue;
		const id = idMatch[1];
		if (seen.has(id)) continue;
		seen.add(id);
		const container = anchor.closest('li, div') || anchor;
		const img = container.querySelector('img');
		const text = (container.innerText || '').replace(/\\s+/g, ' ').trim();
		cards.push({
			id,
			link: 'https://www.douyin.com/video/' + id,
			text: text.slice(0, 220),
			cover: img ? (img.getAttribute('src') || '').slice(0, 300) : '',
			alt: img ? (img.getAttribute('alt') || '').replace(/\\s+/g, ' ').slice(0, 200) : ''
		});
	}
	return cards;
})()`;

/**
 * Read Douyin through a real browser.
 *
 * Douyin signs its API calls with `a_bogus`/`X-Bogus`/`__ac_signature`, computed at
 * runtime inside an obfuscated VM, and answers a plain HTTP client with 403s and
 * empty bodies. Driving a real browser sidesteps the whole problem because the page
 * computes its own signatures.
 */
export class DouyinReader {
	/** @param options - `browser` (a {@link DouyinBrowser}), `maxWaitMs` default `goto` wait. */
	constructor(options = {}) {
		this.browser = options.browser ?? new DouyinBrowser(options.browserOptions);
		this.defaultWaitMs = Number(options.waitMs) || 11000;
	}

	/** Open a page and report what the browser actually rendered. */
	async open(url, { waitMs, signal } = {}) {
		if (signal?.aborted) throw new HttpError("aborted", { code: "ABORTED" });
		const session = await this.browser.goto(url, { waitMs: waitMs ?? this.defaultWaitMs });
		const summary = await session.evaluate(`JSON.stringify({
			title: document.title,
			url: location.href,
			cards: ${EXTRACT_VIDEO_CARDS},
			videoTags: document.querySelectorAll('video').length,
			textLength: document.body ? document.body.innerText.length : 0
		})`);
		return { session, ...JSON.parse(summary) };
	}

	/** The hot board: title, rank, and link for each entry. */
	async hot({ limit = 30, waitMs, signal } = {}) {
		const { cards, url, title } = await this.open(DOUYIN_PAGES.hot.url, { waitMs, signal });
		const rows = cards.slice(0, limit).map((card, index) => {
			const parsed = parseCardText(card);
			return { rank: index + 1, id: card.id, url: card.link, ...parsed, cover: card.cover };
		});
		return {
			source: "https://www.douyin.com/hot",
			landedUrl: url,
			pageTitle: title,
			count: rows.length,
			items: rows,
			note: rows.length === 0
				? "the hot board rendered no video cards — Douyin may be showing a login or captcha wall"
				: "read from the rendered DOM; Douyin's own HTML carries no JSON payload",
		};
	}

	/** One video detail page: caption, author, counts, publish time, comments. */
	async video(ref, { waitMs, commentLimit = 30, signal } = {}) {
		const target = parseDouyinRef(ref);
		const { session, url, cards } = await this.open(target.url, { waitMs, signal });
		const detail = await session.evaluate(`(() => {
			const text = document.body ? document.body.innerText : '';
			const h1 = document.querySelector('h1');
			const counts = [...document.querySelectorAll('[data-e2e]')].map(n => n.getAttribute('data-e2e')).slice(0, 40);
			return JSON.stringify({
				caption: h1 ? h1.innerText.replace(/\\s+/g, ' ').trim() : '',
				text: text.replace(/\\s+/g, ' ').slice(0, 4000),
				videoSrc: document.querySelector('video') ? document.querySelector('video').src : '',
				commentItems: [...document.querySelectorAll('[data-e2e="comment-item"], .comment-item')].slice(0, 60).map(n => n.innerText.replace(/\\s+/g,' ').trim().slice(0, 240)),
				markers: counts
			});
		})()`);
		const parsed = JSON.parse(detail);
		const publishMatch = parsed.text.match(/发布时间：([0-9-]+\s*[0-9:]*)/);
		const statMatch = parsed.text.match(/([0-9.万]+)\\s+([0-9.万]+)\\s+([0-9.万]+)\\s+([0-9.万]+)\\s+举报/);
		const authorMatch = parsed.text.match(/^(.*?)\\s*搜索\\s*充钻石/);
		return {
			videoId: target.id,
			url,
			caption: parsed.caption,
			author: authorMatch ? authorMatch[1].trim().slice(-40) : "",
			publishedAt: publishMatch ? publishMatch[1] : "",
			stats: statMatch ? { like: statMatch[1], comment: statMatch[2], favorite: statMatch[3], share: statMatch[4] } : undefined,
			videoSrc: parsed.videoSrc,
			comments: parsed.commentItems.slice(0, commentLimit),
			related: cards.slice(0, 20).map((c) => ({ id: c.id, url: c.link, ...parseCardText(c) })),
			rawText: parsed.text,
			note: "read from the rendered DOM of a real browser; comment threads beyond the first page need scrolling",
		};
	}

	/** Keyword search — the one surface Douyin gates behind a login wall. */
	async search(keyword, { waitMs, signal } = {}) {
		const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}`;
		const { session, cards, url: landed, title } = await this.open(url, { waitMs, signal });
		const wall = await session.evaluate(
			`/(登录后即可搜索|扫码登录|验证码登录)/.test(document.body ? document.body.innerText : '')`,
		);
		return {
			keyword,
			landedUrl: landed,
			pageTitle: title,
			loginWall: wall === true,
			count: cards.length,
			items: cards.map((c) => ({ id: c.id, url: c.link, ...parseCardText(c) })),
			note: wall === true
				? "Douyin gates keyword search behind a login wall. Sign in once in the plugin's own browser profile (`whale_dive_douyin` with `action: \"login\"`), then search works."
				: cards.length === 0
					? "search rendered no video cards; the result selectors may have changed or the query returned nothing"
					: "read from the rendered DOM",
		};
	}

	/** Open the plugin's browser visibly so the user can sign in once. */
	async login({ timeoutMs = 60000 } = {}) {
		const session = await this.browser.ensureSession({ timeoutMs });
		await session.send("Page.navigate", { url: "https://www.douyin.com/" });
		await session.evaluate("window.focus()");
		const logged = await this.browser.hasLogin(timeoutMs);
		return {
			userDataDir: this.browser.userDataDir,
			loggedIn: logged,
			note: logged
				? "the plugin's browser profile already holds a Douyin session"
				: "a browser window opened on Douyin. Scan the QR code there; the session is stored in the profile directory above and reused afterwards.",
		};
	}

	/** Whether Douyin is reachable and whether the profile is signed in. */
	async status() {
		let reachable = false;
		let loggedIn = false;
		let error;
		try {
			const session = await this.browser.ensureSession({ timeoutMs: 30000 });
			reachable = true;
			loggedIn = (await session.evaluate("document.cookie.includes('sessionid')")) === true;
		} catch (caught) {
			error = describeError(caught);
		}
		return {
			reachable,
			loggedIn,
			browserRunning: this.browser.running,
			port: this.browser.port,
			userDataDir: this.browser.userDataDir,
			...(error ? { error } : {}),
		};
	}

	close() {
		this.browser.close();
	}
}

/**
 * Pull caption/author/date/duration/heat out of a card's flattened inner text.
 *
 * The DOM gives no field boundaries, so this reads the shape Douyin actually
 * renders: `MM:SS  <plays>  <caption>  @author · date`.
 *
 * Two details matter. The duration must be consumed before any number is
 * matched, or `07:06` reports as a play count of 07. And the author is the
 * *last* `@mention`, because creators routinely tag `@抖音音乐` and other
 * official accounts inside the caption itself.
 */
export function parseCardText(card) {
	const text = String(card?.text ?? "");
	const alt = String(card?.alt ?? "");
	const source = (text.length > 0 ? text : alt).replace(/\s+/g, " ").trim();

	const durationMatch = source.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*/);
	const duration = durationMatch
		? durationMatch[1]
		: alt && /^\d{1,2}:\d{2}/.test(alt)
			? alt.split(/\s/)[0]
			: "";
	let rest = durationMatch ? source.slice(durationMatch[0].length) : source;

	// A bare leading number is the play/heat count; it is not part of the caption.
	const playsMatch = rest.match(/^(\d+(?:\.\d+)?)\s*(万|w|W)?\s+/);
	const plays = playsMatch ? `${playsMatch[1]}${playsMatch[2] ?? ""}` : "";
	if (playsMatch) rest = rest.slice(playsMatch[0].length);

	const mentions = [...rest.matchAll(/@([^·\s@][^·@]{0,30})/g)].map((entry) => entry[1].trim());
	const author = mentions.length > 0 ? mentions[mentions.length - 1] : "";
	const dateMatch = rest.match(/·\s*(\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}|昨天|前天|\d+天前|\d+小时前|\d+分钟前)/);
	const date = dateMatch ? dateMatch[1] : "";

	const caption = rest
		.replace(/@[^·\s@][^·@]{0,30}/g, " ")
		.replace(/·\s*(\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}|昨天|前天|\d+天前|\d+小时前|\d+分钟前)/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();

	return { duration, plays, author, date, caption: caption.slice(0, 300) };
}

export { HttpError, describeError };
