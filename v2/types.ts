/**
 * The shapes the panel reads. One set for both renderers: the Desktop part and
 * the TUI call the same RPC and describe the answer the same way.
 */

export type LogEntry = { at: number; kind: string; text: string };

export type Account = {
	providerID: string;
	alias: string;
	/** Whether the balancer can send to it: switched on and not parked. */
	active: boolean;
	/** What would authorise the next request, fallback included. */
	inUse: boolean;
	limited: boolean;
	/** What the endpoint reported when it parked this account. */
	limitedReason?: string;
	/** When the endpoint said its own quota returns, in ms; 0 when it did not say. */
	limitedUntil: number;
	/** When the balancer last pointed at this credential, in ms; 0 when never. */
	lastUsedAt: number;
	failures: number;
};

export type Status = { balancing: boolean };
export type Listed = { accounts: Account[] };
export type Reply = { ok: boolean; message: string };
export type ContextState = { value: string };
export type BufferState = { enforce: string; value: string };
export type RebalanceState = { auto: boolean; value: string };

export type Target = {
	modelID: string;
	providerID: string;
	/** What is actually sent, once a free-only provider substitutes. */
	resolved: string;
	state: string;
};
export type Chain = {
	key: string;
	label: string;
	package: string;
	/** This model's own limit as typed, empty when it follows the global. */
	limit: string;
	stored: boolean;
	targets: Target[];
};
export type Chains = { rows: Chain[] };
export type Provider = {
	/** The credential's own name within the provider. */
	alias: string;
	enabled: boolean;
	freeOnly: boolean;
	/** The provider's display name. */
	name: string;
	position: number;
	providerID: string;
};
export type Providers = { entries: Provider[] };
export type Models = { models: { modelID: string; name: string }[] };
