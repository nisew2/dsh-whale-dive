/**
 * Bilibili WBI request signing.
 *
 * Bilibili's web interface gates a growing share of its read routes behind a
 * `w_rid` signature: the caller must prove it knew the two rotating key
 * fragments the site publishes on its own `nav` endpoint. Without a signature,
 * routes such as `x/space/wbi/acc/info` and `x/web-interface/wbi/search/type`
 * answer `code: -352` (risk control) even from a clean client.
 *
 * The scheme, as implemented by the site itself:
 *
 *   1. `GET x/web-interface/nav` returns `data.wbi_img.img_url` and `sub_url`.
 *      Take each URL's basename and drop the extension — those are `img_key`
 *      and `sub_key`.
 *   2. Concatenate them into `origin = img_key + sub_key`, then permute `origin`
 *      with a fixed 64-entry index table and keep the first 32 characters. That
 *      is `mixin_key`.
 *   3. For a request, add `wts` (Unix seconds), sort parameters by key, drop
 *      `!'()*` from every value, URL-encode the result, and set
 *      `w_rid = md5(encoded + mixin_key)`.
 *
 * The keys rotate, so this module caches them with a TTL and re-fetches on
 * expiry or on a signing failure.
 *
 * @module dsh-whale-dive/wbi
 */
import { createHash } from "node:crypto";

/** The site's fixed permutation table for `img_key + sub_key` (64 entries). */
export const MIXIN_KEY_ENC_TAB = Object.freeze([
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
	27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
	37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
	22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]);

/** Keys are stable for hours; ten minutes keeps a rotation from breaking a session. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Characters the site strips from values before hashing. */
const FILTERED = /[!'()*]/g;

/** Lowercase hex MD5 of a UTF-8 string. */
export function md5Hex(input) {
	return createHash("md5").update(input, "utf8").digest("hex");
}

/**
 * Extract the bare key from a `wbi_img` URL, e.g.
 * `https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png` →
 * `7cd084941338484aae1ad9425b84077c`.
 *
 * @param url - the `img_url` or `sub_url` value.
 * @returns the basename without its extension, or `""` when unparseable.
 */
export function keyFromUrl(url) {
	if (typeof url !== "string" || url.length === 0) return "";
	const withoutQuery = url.split(/[?#]/u, 1)[0];
	const basename = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
	const dot = basename.lastIndexOf(".");
	return dot > 0 ? basename.slice(0, dot) : basename;
}

/**
 * Derive `mixin_key` from the two key fragments.
 *
 * @param imgKey - `img_url`'s basename without extension.
 * @param subKey - `sub_url`'s basename without extension.
 * @returns the first 32 characters of the permuted concatenation.
 */
export function mixinKeyFrom(imgKey, subKey) {
	const origin = `${imgKey}${subKey}`;
	let mixin = "";
	for (const index of MIXIN_KEY_ENC_TAB) {
		if (index >= origin.length) continue;
		mixin += origin[index];
		if (mixin.length === 32) break;
	}
	return mixin;
}

/**
 * Sign a parameter set.
 *
 * @param params - parameters to sign; not mutated.
 * @param mixinKey - the derived `mixin_key`.
 * @param nowSeconds - `wts` override, for tests.
 * @returns `{ ...params, wts, w_rid }` ready to serialize.
 */
export function signParams(params, mixinKey, nowSeconds) {
	const wts = nowSeconds ?? Math.floor(Date.now() / 1000);
	const withWts = { ...params, wts: String(wts) };
	const query = Object.keys(withWts)
		.sort()
		.map((key) => {
			const value = String(withWts[key] ?? "").replace(FILTERED, "");
			return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
		})
		.join("&");
	return { ...withWts, w_rid: md5Hex(query + mixinKey) };
}

/**
 * Holds the cached `mixin_key` and refreshes it when it goes stale.
 *
 * A signer is constructed with a `fetchKeys` callback (which performs the `nav`
 * request itself) so this module never needs to know about the HTTP layer.
 */
export class WbiSigner {
	/**
	 * @param options - `fetchKeys` returns `{ imgKey, subKey }`; `ttlMs` overrides the cache lifetime.
	 */
	constructor(options = {}) {
		if (typeof options.fetchKeys !== "function") {
			throw new TypeError("WbiSigner requires a fetchKeys callback");
		}
		this.fetchKeys = options.fetchKeys;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.mixinKey = "";
		this.imgKey = "";
		this.subKey = "";
		this.fetchedAt = 0;
		this.refreshes = 0;
		this.inflight = null;
	}

	/** Cached key state for diagnostics. */
	get expiresInMs() {
		return this.fetchedAt === 0 ? 0 : Math.max(0, this.fetchedAt + this.ttlMs - Date.now());
	}

	/**
	 * Return a usable `mixin_key`, refreshing when stale.
	 *
	 * @param options - `force` bypasses a still-valid cache; `signal` cancels.
	 * @returns the `mixin_key`.
	 */
	async key(options = {}) {
		const fresh = this.mixinKey.length === 32 && Date.now() - this.fetchedAt < this.ttlMs && options.force !== true;
		if (fresh) return this.mixinKey;
		if (this.inflight) return this.inflight;
		this.inflight = (async () => {
			try {
				const { imgKey, subKey } = await this.fetchKeys({ signal: options.signal });
				if (!imgKey || !subKey) {
					throw new Error("nav did not expose wbi_img.img_url / sub_url; cannot sign");
				}
				this.imgKey = imgKey;
				this.subKey = subKey;
				this.mixinKey = mixinKeyFrom(imgKey, subKey);
				this.fetchedAt = Date.now();
				this.refreshes += 1;
				return this.mixinKey;
			} finally {
				this.inflight = null;
			}
		})();
		return this.inflight;
	}

	/**
	 * Sign a parameter set, refreshing the cache once on the first attempt.
	 *
	 * @param params - parameters to sign.
	 * @param options - `signal` cancels; `wts` pins the timestamp.
	 * @returns the signed parameter map.
	 */
	async sign(params, options = {}) {
		const mixinKey = await this.key({ signal: options.signal });
		return signParams(params, mixinKey, options.wts);
	}

	/** Drop the cached keys so the next `key()` refetches. */
	invalidate() {
		this.mixinKey = "";
		this.fetchedAt = 0;
	}
}
