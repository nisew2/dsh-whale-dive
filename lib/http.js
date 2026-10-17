/**
 * The paced HTTP client the Bilibili layer sits on.
 *
 * Every request goes through the {@link Pacer}, carries a browser-shaped header
 * set, and is translated into either a parsed payload or a typed error. The
 * translation is where the value is: these APIs report trouble as HTTP 412, as
 * a 200 body with `code: -412` / `code: -352`, or as a 200 body with a
 * non-zero business code, and each of those means something different to the
 * caller. Collapsing them all into "request failed" loses the only information
 * that tells the model whether to slow down, change the identifier, or stop.
 *
 * @module dsh-whale-dive/http
 */
import { Pacer, PacerError, sleep } from "./limiter.js";

/** A desktop UA. The JSON routes do not require one, but the HTML routes do. */
export const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Codes the site uses to mean "you are being rate limited, not rejected". */
const RISK_CODES = new Set([-412, -352, -509]);

/** Human labels for the business codes worth naming in an error message. */
const CODE_LABELS = new Map([
	[-101, "not logged in (this route needs a signed-in session)"],
	[-352, "risk control rejected the request (the WBI signature was missing, stale, or the IP is flagged)"],
	[-400, "bad request parameters"],
	[-403, "forbidden: the resource exists but access is denied"],
	[-404, "the resource was not found"],
	[-412, "request intercepted: too many requests from this IP"],
	[-509, "request overloaded: rate limited by the upstream"],
	[62002, "the item is not publicly visible (private, removed, or region-locked)"],
	[62004, "the item is under review"],
	[22001, "the requested part index does not exist"],
	[0, "ok"],
]);

/**
 * Failure raised by {@link HttpClient}. Carries enough structure for a tool to
 * decide whether to retry, slow down, or give up.
 */
export class HttpError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = "HttpError";
		/** Stable machine code: `HTTP_ERROR` / `HTTP_STATUS` / `BILI_CODE` / `RISK` / `TIMEOUT` / `ABORTED` / `PARSE`. */
		this.code = options.code ?? "HTTP_ERROR";
		this.url = options.url;
		this.status = options.status;
		/** Bilibili's application-level `code`, when the body carried one. */
		this.upstreamCode = options.upstreamCode;
		/** True when the failure is a rate-limit signal rather than a bad request. */
		this.risk = options.risk === true;
		this.retryAfterMs = options.retryAfterMs ?? 0;
		/** The parsed body, when one was read and is small enough to be useful. */
		this.body = options.body;
	}
}

/** Sleep, honoring an abort signal; exposed so callers can reuse the pacer's helper. */
export { sleep };

/**
 * The shared client. One instance per plugin activation, so every tool shares
 * one pacing budget and one set of breakers.
 */
export class HttpClient {
	/**
	 * @param options - `pacer` injects a shared pacer; the rest are request defaults.
	 */
	constructor(options = {}) {
		this.pacer = options.pacer ?? new Pacer(options.pacerOptions);
		this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
		this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20000);
		this.defaultHeaders = { ...(options.headers ?? {}) };
		this.requests = 0;
		this.riskSignals = 0;
	}

	/**
	 * Perform one paced request and return the decoded body.
	 *
	 * @param url - absolute URL.
	 * @param options - `method`, `headers`, `body`, `signal`, `host` override for pacing group,
	 *   `json` to force JSON parsing, `raw` to skip parsing entirely, `timeoutMs`, `label`.
	 * @returns `{ status, url, headers, json, text }` — `json` is populated when the body parsed.
	 * @throws {HttpError} on transport failure, non-2xx status, or an unparseable required body.
	 */
	async request(url, options = {}) {
		const host = options.host ?? new URL(url).host;
		const label = options.label ?? `${options.method ?? "GET"} ${url}`;
		const timeoutMs = Math.max(1000, Number(options.timeoutMs) || this.timeoutMs);
		return this.pacer.run(
			host,
			async () => {
				const controller = new AbortController();
				const onAbort = () => controller.abort(options.signal?.reason);
				if (options.signal) {
					if (options.signal.aborted) onAbort();
					else options.signal.addEventListener("abort", onAbort, { once: true });
				}
				const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
				let response;
				try {
					response = await fetch(url, {
						method: options.method ?? "GET",
						headers: {
							"user-agent": this.userAgent,
							accept: "application/json, text/plain, */*",
							"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
							...this.defaultHeaders,
							...(options.headers ?? {}),
						},
						body: options.body,
						redirect: "follow",
						signal: controller.signal,
					});
				} catch (error) {
					const aborted = controller.signal.aborted;
					const cause = aborted && error?.message === "timeout" ? "TIMEOUT" : "ABORTED";
					throw new HttpError(
						aborted && cause === "TIMEOUT"
							? `${label} timed out after ${timeoutMs}ms`
							: `${label} was aborted before a response arrived: ${error?.message ?? error}`,
						{ code: cause, url, risk: aborted && cause === "TIMEOUT" },
					);
				} finally {
					clearTimeout(timer);
					if (options.signal) options.signal.removeEventListener("abort", onAbort);
				}
				this.requests += 1;
				const text = await response.text();
				/** `parse: false` keeps the body as text only; the default attempts JSON. */
				const wantsJson = options.parse !== false;
				let json;
				if (wantsJson && text.length > 0) {
					try {
						json = JSON.parse(text);
					} catch {
						json = undefined;
					}
				}
				if (response.status === 412) {
					this.riskSignals += 1;
					throw new HttpError(
						`${label} was answered with HTTP 412 — Bilibili intercepted the request as a burst from this IP. ` +
							"Stop calling, lower the rate, and retry after the cool-down window.",
						{ code: "RISK", status: 412, url, risk: true, retryAfterMs: this.pacer.cooldown(host).retryAfterMs },
					);
				}
				if (!response.ok) {
					const upstreamCode = typeof json?.code === "number" ? json.code : undefined;
					const risk = upstreamCode !== undefined && RISK_CODES.has(upstreamCode);
					if (risk) this.riskSignals += 1;
					throw new HttpError(
						`${label} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}` +
							(upstreamCode === undefined ? "" : ` (code ${upstreamCode}: ${CODE_LABELS.get(upstreamCode) ?? "unknown"})`),
						{ code: risk ? "RISK" : "HTTP_STATUS", status: response.status, url, upstreamCode, risk, body: json },
					);
				}
				if (wantsJson && options.json !== false && json === undefined && text.length > 0) {
					throw new HttpError(`${label} returned a body that is not JSON (${text.length} bytes); the route may have changed`, {
						code: "PARSE",
						status: response.status,
						url,
						body: text.slice(0, 400),
					});
				}
				return { status: response.status, url: response.url, headers: response.headers, json, text };
			},
			{ signal: options.signal },
		);
	}

	/**
	 * Perform a request and enforce the API envelope (`{ code, message, data }`).
	 *
	 * A non-zero `code` becomes a typed {@link HttpError}; a risk code also trips
	 * the breaker for the host through the pacer's risk path.
	 *
	 * @param url - absolute URL.
	 * @param options - as {@link HttpClient.request}, plus `allowCodes` for codes that are expected.
	 * @returns `response.json.data`, or the whole envelope when `unwrap` is false.
	 */
	async api(url, options = {}) {
		const host = options.host ?? new URL(url).host;
		const response = await this.request(url, options);
		const envelope = response.json;
		if (!envelope || typeof envelope !== "object" || typeof envelope.code !== "number") {
			throw new HttpError(`${options.label ?? url} did not return a Bilibili envelope ({ code, message, data })`, {
				code: "PARSE",
				status: response.status,
				url,
				body: response.text.slice(0, 400),
			});
		}
		const allow = new Set(options.allowCodes ?? []);
		if (envelope.code !== 0 && !allow.has(envelope.code)) {
			const risk = RISK_CODES.has(envelope.code);
			if (risk) this.riskSignals += 1;
			const detail = CODE_LABELS.get(envelope.code);
			throw new HttpError(
				`${options.label ?? url} answered code ${envelope.code}: ${envelope.message || detail || "no message"}` +
					(detail ? ` — ${detail}` : ""),
				{
					code: risk ? "RISK" : "BILI_CODE",
					status: response.status,
					url,
					upstreamCode: envelope.code,
					risk,
					body: envelope,
				},
			);
		}
		return options.unwrap === false ? envelope : envelope.data;
	}

	/** JSON GET with `params` serialized into the query string. */
	async getJson(url, params, options = {}) {
		const target = new URL(url);
		for (const [key, value] of Object.entries(params ?? {})) {
			if (value === undefined || value === null) continue;
			target.searchParams.set(key, String(value));
		}
		return this.api(target.href, { ...options, label: options.label ?? `GET ${target.pathname}` });
	}

	/** GET a non-JSON body (HTML, XML, protobuf-ish `.so` payloads) as decoded text. */
	async getText(url, options = {}) {
		return this.request(url, {
			...options,
			parse: false,
			json: false,
			label: options.label ?? `GET ${new URL(url).pathname}`,
		});
	}

	/** Pacer snapshot, surfaced by the status tool. */
	status() {
		return { ...this.pacer.status(), requests: this.requests, riskSignals: this.riskSignals };
	}
}

/**
 * Normalize any thrown value into a model-facing message plus a stable code.
 *
 * @param error - whatever was thrown.
 * @returns `{ code, message, retryAfterMs, risk }`.
 */
export function describeError(error) {
	if (error instanceof HttpError || error instanceof PacerError) {
		return {
			code: error.code,
			message: error.message,
			retryAfterMs: error.retryAfterMs ?? 0,
			risk: error.risk === true,
		};
	}
	if (error instanceof Error) {
		return { code: error.name || "ERROR", message: error.message, retryAfterMs: 0, risk: false };
	}
	return { code: "ERROR", message: String(error), retryAfterMs: 0, risk: false };
}
