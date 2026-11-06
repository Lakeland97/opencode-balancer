import type { AuthInfo } from "../core/types";

const API_KEY_HEADERS = [
	"authorization",
	"x-api-key",
	"api-key",
	"x-goog-api-key",
	"x-stainless-api-key",
	"anthropic-api-key",
	"cohere-api-key",
];

/**
 * Overwrite the credential-bearing headers of an outgoing request with a saved
 * account's credentials.
 *
 * `preserveExistingOAuth` keeps an Authorization header that opencode already
 * minted itself, which is what the first attempt of an OAuth request relies on.
 */
export function applyAuthToHeaders(
	headers: Headers,
	auth: AuthInfo,
	options: { preserveExistingOAuth?: boolean } = {},
) {
	if (auth.type === "oauth") {
		if (options.preserveExistingOAuth && headers.has("authorization")) return;
		headers.set("authorization", `Bearer ${auth.access}`);
		return;
	}

	if (auth.type === "wellknown") {
		if (headers.has("authorization")) {
			headers.set("authorization", `Bearer ${auth.token}`);
		} else {
			headers.set(auth.key, auth.token);
		}
		return;
	}

	let changed = false;
	for (const name of API_KEY_HEADERS) {
		const current = headers.get(name);
		if (!current) continue;
		headers.set(
			name,
			name === "authorization" && current.toLowerCase().startsWith("bearer ")
				? `Bearer ${auth.key}`
				: auth.key,
		);
		changed = true;
	}

	if (!changed) headers.set("authorization", `Bearer ${auth.key}`);
}
