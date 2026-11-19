/**
 * The panel's English copy, shared by the GUI, the TUI and command output.
 *
 * The GUI still calls `ctx.t(...)`; this object is its `en` table. The TUI has
 * no translator in its context, and commands are plain text, so both read the
 * same values directly. One source of words keeps the three surfaces from
 * drifting.
 */
export const copy = {
	active: "active",
	addTarget: "add target",
	always: "always",
	apply: "apply",
	assumedFrom: "assumed from",
	assumeWindows: "assume windows",
	at: "at",
	automatic: "automatic",
	balancing: "balancing",
	buffer: "buffer",
	builtIn: "built-in",
	cancel: "cancel",
	clear: "clear",
	collapse: "collapse all",
	contextLimit: "context limit",
	custom: "custom",
	cut: "cut",
	defaultValue: "default",
	diagnostics: "diagnostics",
	enforce: "enforce",
	everyProviderUsed: "every provider is already in this chain",
	expand: "expand all",
	free: "free",
	globalShare: "global",
	inUse: "in use",
	lastTried: "last tried",
	limit: "limit",
	limited: "limited",
	logEmpty: "nothing yet",
	models: "models",
	moving: "moving",
	necessary: "when necessary",
	newChain: "new chain",
	noChains: "No chains.",
	noReason: "no reason was recorded for this park",
	notReadYet: "not read yet",
	open: "Open Balancer",
	openSession: "Open a session first.",
	pickProvider: "pick a provider first",
	provider: "provider",
	providers: "providers",
	rebalance: "rebalance after",
	refresh: "refresh",
	reset: "reset",
	resets: "resets",
	title: "Balancer",
	unknownWindow: "unknown",
	use: "use",
	values: "values",
	version: "version",
} as const;

export type CopyKey = keyof typeof copy;
