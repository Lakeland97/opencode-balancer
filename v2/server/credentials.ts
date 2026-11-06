import type { Context } from "@opencode/plugin";
import type { AuthInfo } from "../core/types";

function stringMetadata(
	value: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Convert a V2 integration credential into the account shape the balancer
 * store keeps. `external` credentials carry no reusable secret, so they are
 * not importable as accounts.
 */
export function credentialToAuth(value: unknown): AuthInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const credential = value as Record<string, unknown>;

	if (credential.type === "oauth") {
		const { refresh, access, expires } = credential;
		if (
			typeof refresh !== "string" ||
			typeof access !== "string" ||
			typeof expires !== "number"
		) {
			return undefined;
		}
		const metadata = stringMetadata(
			credential.metadata as Record<string, unknown> | undefined,
		);
		return {
			type: "oauth",
			refresh,
			access,
			expires,
			...(metadata ? { metadata } : {}),
		};
	}

	if (credential.type === "key") {
		if (typeof credential.key !== "string") return undefined;
		const metadata = stringMetadata(
			credential.metadata as Record<string, unknown> | undefined,
		);
		return { type: "api", key: credential.key, ...(metadata ? { metadata } : {}) };
	}

	return undefined;
}

export async function readActiveCredential(ctx: Context, providerID: string) {
	const connection = await ctx.integration.connection.active(providerID);
	if (!connection) return undefined;
	const value = await ctx.integration.connection.resolve(connection);
	return credentialToAuth(value);
}
