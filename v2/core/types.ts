export type AuthInfo =
	| { type: "api"; key: string; metadata?: Record<string, string> }
	| {
			type: "oauth";
			refresh: string;
			access: string;
			expires: number;
			accountId?: string;
			enterpriseUrl?: string;
			metadata?: Record<string, string>;
	  }
	| {
			type: "wellknown";
			key: string;
			token: string;
			metadata?: Record<string, string>;
	  };

export type Account = {
	providerID: string;
	alias: string;
	auth: AuthInfo;
	authType: AuthInfo["type"];
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	rateLimitedUntil?: number;
	failures: number;
	disabled: boolean;
	/**
	 * Where this credential sits in the balancer's order. Credentials are the
	 * unit the panel lists and the router walks, so the order spans providers:
	 * a provider's place is the earliest of its credentials.
	 */
	position: number;
	/** Whether this credential may only use models that cost nothing. */
	freeOnly: boolean;
	/** The OpenCode credential this account was imported from, when it was. */
	sourceID?: string;
};

export type ProviderState = {
	providerID: string;
	activeAlias?: string;
	updatedAt: number;
	metadata: Record<string, string>;
};

export type SelectedModel = {
	providerID: string;
	modelID: string;
};

export type PendingConnection = {
	id: string;
	providerID: string;
	auth: AuthInfo;
	authType: AuthInfo["type"];
	source: "auth-file" | "http" | "oauth-callback";
	capturedAt: number;
	promptStatus: "new" | "prompted" | "dismissed";
};

export type BalancerEventType =
	| "pending_connection_captured"
	| "account_saved"
	| "account_activated"
	| "account_removed"
	| "usage_refreshed"
	| "usage_unavailable"
	| "rate_limit_detected"
	| "failover_performed"
	| "provider_refused"
	| "provider_unreachable"
	| "error_reached_session";

export type BalancerEvent = {
	id: string;
	type: BalancerEventType;
	providerID?: string;
	alias?: string;
	message: string;
	createdAt: number;
	metadata: Record<string, string>;
};
