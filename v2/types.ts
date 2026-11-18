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
export type RebalanceState = {
	auto: boolean;
	/** When the client's balance next lapses, in ms; 0 when nothing is counting down. */
	nextAt: number;
	value: string;
};

export type Target = {
	modelID: string;
	/** The connector's own name for the model, which tells a row's targets apart. */
	name: string;
	providerID: string;
	/** The window this target reports, or 0 when it reports none. */
	context: number;
	/** What is actually sent, once a free-only provider substitutes. */
	resolved: string;
	state: string;
};
export type Chain = {
	key: string;
	label: string;
	package: string;
	/** The tightest real window this row's targets report; 0 when none does. */
	context: number;
	/** This model's own limit as typed, empty when it follows the global. */
	limit: string;
	stored: boolean;
	targets: Target[];
};
export type Chains = { rows: Chain[] };
/**
 * One row currently being served: which provider, which model, and at what
 * thinking level. More than one at a time is normal — a conversation split
 * across models because a provider was unavailable shows as several entries.
 */
export type InUseEntry = {
	alias: string;
	/** The agent that made the call, e.g. `build`. Empty when it was not told. */
	agent: string;
	/** The level actually applied on the connector, empty when there is none. */
	applied: string;
	/** When this row last served, in ms; a stale row is dropped by the server. */
	at: number;
	familyKey: string;
	label: string;
	/**
	 * The connector's own model id — what was really called. Not the row's label
	 * and not the id the host named: a routed row is a name this plugin invented,
	 * and the provider only ever sees this one.
	 */
	modelID: string;
	providerID: string;
	/** The thinking level the request asked for, empty when it asked for none. */
	variant: string;
};
export type InUse = { entries: InUseEntry[] };
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
