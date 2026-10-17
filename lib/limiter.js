/**
 * Request pacing for the whale-dive tools: a per-host token bucket, a global
 * concurrency gate, and a per-host circuit breaker that reacts to the risk
 * signals these APIs actually send.
 *
 * The Bilibili web APIs answer an over-eager client with HTTP 412 on the
 * interface routes (the site HTML and a few list routes stay 200) or with a
 * JSON body whose `code` is `-412` / `-352`. Both are IP-scoped, both ignore
 * Cookie/Referer/User-Agent, and both outlive the burst that caused them by
 * minutes. So the pacer does three things a plain delay loop does not:
 *
 *   1. it shapes steady-state traffic to a rate the interface tolerates,
 *   2. it serializes enough to keep the in-flight count low,
 *   3. it opens a breaker the moment a risk signal arrives, so the next calls
 *      fail fast with a readable reason instead of deepening the block.
 *
 * @module dsh-whale-dive/limiter
 */

/** Raised when the pacer refuses to dispatch, or when a call is judged risky. */
export class PacerError extends Error {
	/**
	 * @param message - human-readable, model-facing explanation.
	 * @param options - classification carried to the caller and the breaker.
	 */
	constructor(message, options = {}) {
		super(message);
		this.name = "PacerError";
		/** Stable machine code: `PACER_COOLDOWN` / `PACER_QUEUE_FULL` / `PACER_ABORTED` / `RISK_SIGNAL`. */
		this.code = options.code ?? "PACER_ERROR";
		/** True when the failure is a provider risk signal that should trip the breaker. */
		this.risk = options.risk === true;
		/** Host key the pacer grouped this call under. */
		this.host = options.host ?? "";
		/** How long the caller should wait before retrying, in ms (0 when unknown). */
		this.retryAfterMs = options.retryAfterMs ?? 0;
		/** Upstream HTTP status when the failure came from a response. */
		this.status = options.status;
		/** Upstream application code (Bilibili `code`, for example). */
		this.upstreamCode = options.upstreamCode;
	}
}

/** Defaults chosen to sit inside the observed safe band rather than at its edge. */
export const DEFAULT_PACER = Object.freeze({
	requestsPerSecond: 4,
	burst: 8,
	maxConcurrent: 3,
	cooldownMs: 120000,
	maxCooldownMs: 600000,
	maxQueue: 64,
});

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
export function sleep(ms, signal) {
	if (!(ms > 0)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("aborted"));
		};
		if (!signal) return;
		if (signal.aborted) {
			cleanup();
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** One lazy-refilled leaky bucket. */
class Bucket {
	constructor(rate, capacity) {
		this.rate = rate;
		this.capacity = capacity;
		this.tokens = capacity;
		this.updatedAt = Date.now();
	}

	refill(now) {
		const elapsed = (now - this.updatedAt) / 1000;
		if (elapsed <= 0) return;
		this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
		this.updatedAt = now;
	}

	/** Consume one token; returns 0 on success or the ms to wait before retrying. */
	take(now = Date.now()) {
		this.refill(now);
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return 0;
		}
		return Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
	}

	scale(rate, capacity) {
		this.rate = rate;
		this.capacity = capacity;
		this.tokens = Math.min(this.tokens, capacity);
	}
}

/** Per-host circuit breaker with exponential cool-down. */
class Breaker {
	constructor() {
		this.failures = 0;
		this.openUntil = 0;
		this.trips = 0;
		this.lastReason = "";
		this.lastTripAt = 0;
	}

	get open() {
		return Date.now() < this.openUntil;
	}

	remainingMs() {
		return Math.max(0, this.openUntil - Date.now());
	}

	/** Open the breaker for a back-off derived from the consecutive trip count. */
	trip(cooldownMs, maxCooldownMs, reason) {
		this.failures += 1;
		this.trips += 1;
		const factor = 2 ** Math.min(this.failures - 1, 4);
		const waitMs = Math.min(maxCooldownMs, Math.round(cooldownMs * factor));
		this.openUntil = Date.now() + waitMs;
		this.lastReason = reason;
		this.lastTripAt = Date.now();
		return waitMs;
	}
}

/**
 * Combined rate limiter, concurrency gate, and risk breaker.
 *
 * `run(host, fn)` is the only entry point callers need: it queues, waits for a
 * token, invokes `fn`, and translates a `risk`-flagged {@link PacerError} into a
 * breaker trip. Hosts are independent, so a Bilibili cool-down never blocks the
 * Douyin browser path.
 */
export class Pacer {
	/**
	 * @param options - pacing policy; every field falls back to {@link DEFAULT_PACER}.
	 */
	constructor(options = {}) {
		const merged = { ...DEFAULT_PACER, ...options };
		this.requestsPerSecond = Math.max(0.1, Number(merged.requestsPerSecond) || DEFAULT_PACER.requestsPerSecond);
		this.burst = Math.max(1, Math.floor(Number(merged.burst) || DEFAULT_PACER.burst));
		this.maxConcurrent = Math.max(1, Math.floor(Number(merged.maxConcurrent) || DEFAULT_PACER.maxConcurrent));
		this.cooldownMs = Math.max(1000, Number(merged.cooldownMs) || DEFAULT_PACER.cooldownMs);
		this.maxCooldownMs = Math.max(this.cooldownMs, Number(merged.maxCooldownMs) || DEFAULT_PACER.maxCooldownMs);
		this.maxQueue = Math.max(1, Math.floor(Number(merged.maxQueue) || DEFAULT_PACER.maxQueue));
		this.buckets = new Map();
		this.breakers = new Map();
		this.inflight = 0;
		this.waitQueue = [];
		this.dispatched = 0;
		this.blocked = 0;
	}

	bucketFor(host) {
		let bucket = this.buckets.get(host);
		if (!bucket) {
			bucket = new Bucket(this.requestsPerSecond, this.burst);
			this.buckets.set(host, bucket);
		}
		return bucket;
	}

	breakerFor(host) {
		let breaker = this.breakers.get(host);
		if (!breaker) {
			breaker = new Breaker();
			this.breakers.set(host, breaker);
		}
		return breaker;
	}

	/** Whether `host` is currently in cool-down, and for how much longer. */
	cooldown(host) {
		const breaker = this.breakerFor(host);
		return { open: breaker.open, retryAfterMs: breaker.remainingMs(), reason: breaker.lastReason };
	}

	acquireSlot(host, signal) {
		if (this.inflight < this.maxConcurrent) {
			this.inflight += 1;
			return Promise.resolve();
		}
		if (this.waitQueue.length >= this.maxQueue) {
			this.blocked += 1;
			throw new PacerError(
				`pacer queue is full (${this.maxQueue} waiting) while acquiring a ${host} slot; try again shortly`,
				{ code: "PACER_QUEUE_FULL", host },
			);
		}
		return new Promise((resolve, reject) => {
			const entry = {
				host,
				grant: () => {
					detach();
					this.inflight += 1;
					resolve();
				},
				fail: (error) => {
					detach();
					reject(error);
				},
			};
			const detach = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				const index = this.waitQueue.indexOf(entry);
				if (index >= 0) this.waitQueue.splice(index, 1);
				this.blocked += 1;
				entry.fail(new PacerError(`aborted while queued for a ${host} slot`, { code: "PACER_ABORTED", host }));
			};
			if (signal) {
				if (signal.aborted) {
					this.blocked += 1;
					reject(new PacerError(`aborted before queuing for a ${host} slot`, { code: "PACER_ABORTED", host }));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.waitQueue.push(entry);
		});
	}

	releaseSlot() {
		const next = this.waitQueue.shift();
		if (next) {
			next.grant();
			return;
		}
		this.inflight = Math.max(0, this.inflight - 1);
	}

	async awaitToken(host, signal) {
		for (;;) {
			const waitMs = this.bucketFor(host).take();
			if (waitMs <= 0) return;
			await sleep(waitMs, signal);
		}
	}

	/**
	 * Dispatch one paced call.
	 *
	 * @param host - independent pacing group (typically the request host).
	 * @param fn - the call to run once a slot and a token are held.
	 * @param options - optional `signal` for cooperative cancellation.
	 * @returns whatever `fn` resolves to.
	 * @throws {PacerError} while cooling down, while the queue is full, or when `fn` signals risk.
	 */
	async run(host, fn, options = {}) {
		const key = host || "default";
		const signal = options.signal;
		const breaker = this.breakerFor(key);
		if (breaker.open) {
			this.blocked += 1;
			const retryAfterMs = breaker.remainingMs();
			throw new PacerError(
				`pacer is cooling down ${key} for another ${Math.ceil(retryAfterMs / 1000)}s after ${breaker.lastReason || "a risk signal"}; ` +
					"reduce the call rate and retry after that window",
				{ code: "PACER_COOLDOWN", host: key, retryAfterMs },
			);
		}
		await this.acquireSlot(key, signal);
		try {
			await this.awaitToken(key, signal);
			this.dispatched += 1;
			try {
				const value = await fn();
				breaker.failures = 0;
				return value;
			} catch (error) {
				if (error instanceof PacerError && error.risk) {
					const retryAfterMs = breaker.trip(this.cooldownMs, this.maxCooldownMs, error.message);
					error.retryAfterMs = retryAfterMs;
					error.host = key;
				}
				throw error;
			}
		} finally {
			this.releaseSlot();
		}
	}

	/** Manually trip a host breaker (used for signals detected outside `run`). */
	trip(host, reason, cooldownMs) {
		const breaker = this.breakerFor(host || "default");
		return breaker.trip(cooldownMs ?? this.cooldownMs, this.maxCooldownMs, reason);
	}

	/** Clear a host breaker and its failure streak. */
	reset(host) {
		const breaker = this.breakerFor(host || "default");
		breaker.failures = 0;
		breaker.openUntil = 0;
		breaker.lastReason = "";
	}

	/** Snapshot for the status tool and for diagnostics in an error message. */
	status() {
		const hosts = {};
		for (const host of new Set([...this.buckets.keys(), ...this.breakers.keys()])) {
			const bucket = this.bucketFor(host);
			const breaker = this.breakerFor(host);
			hosts[host] = {
				tokens: Math.round(bucket.tokens * 100) / 100,
				capacity: bucket.capacity,
				ratePerSecond: bucket.rate,
				coolingDown: breaker.open,
				cooldownRemainingMs: breaker.remainingMs(),
				trips: breaker.trips,
				lastReason: breaker.lastReason,
			};
		}
		return {
			requestsPerSecond: this.requestsPerSecond,
			burst: this.burst,
			maxConcurrent: this.maxConcurrent,
			inflight: this.inflight,
			queued: this.waitQueue.length,
			dispatched: this.dispatched,
			blocked: this.blocked,
			hosts,
		};
	}
}
