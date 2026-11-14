/** @jsxImportSource solid-js */

// Stamped by vite at build time; guards against reading a stale panel.
declare const __BALANCER_BUILT_AT__: string;

import {
	Command,
	MenuItem,
	Panel,
	type PanelTab,
	Plugin,
	TitlebarItem,
} from "@opencode/plugin/gui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
	effectiveThreshold,
	formatTokens,
	MAX_PERCENT,
	parseBuffer,
	parseLimit,
} from "./core/context";
import { groupByBrand } from "./core/models";
import { Balancer } from "./rpc";

type LogEntry = { at: number; kind: string; text: string };

type Account = {
	providerID: string;
	alias: string;
	/** Whether the balancer can send to it: switched on and not parked. */
	active: boolean;
	/** What would authorise the next request, fallback included. */
	inUse: boolean;
	limited: boolean;
	/** What the endpoint reported when it parked this account. */
	limitedReason?: string;
	failures: number;
};

type Status = { balancing: boolean };
type Listed = { accounts: Account[] };
type Reply = { ok: boolean; message: string };
type ContextState = { value: string };
type BufferState = { enforce: string; value: string };

type Target = {
	modelID: string;
	providerID: string;
	/** What is actually sent, once a free-only provider substitutes. */
	resolved: string;
	state: string;
};
type Chain = {
	key: string;
	label: string;
	package: string;
	/** This model's own limit as typed, empty when it follows the global. */
	limit: string;
	stored: boolean;
	targets: Target[];
};
type Chains = { rows: Chain[] };
type Provider = {
	/** The credential's own name within the provider. */
	alias: string;
	enabled: boolean;
	freeOnly: boolean;
	/** The provider's display name. */
	name: string;
	position: number;
	providerID: string;
};
type Providers = { entries: Provider[] };
type Models = { models: { modelID: string; name: string }[] };

/** Model pickers read alphabetically, by the name the picker shows. */
function sortByName(models: { modelID: string; name: string }[]) {
	return models
		.slice()
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
}

/** A failure the RPC layer raised: not everything it throws is an Error. */
function describe(error: unknown) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** The build stamp vite bakes in, so a stale panel is obvious. */
function builtAt() {
	return typeof __BALANCER_BUILT_AT__ === "string"
		? __BALANCER_BUILT_AT__
		: "dev";
}

export default Plugin.define({
	i18n: {
		en: {
			active: "active",
			addTarget: "add target",
			always: "always",
			apply: "apply",
			balancing: "balancing",
			buffer: "buffer",
			clear: "clear",
			collapse: "collapse all",
			contextLimit: "context limit",
			diagnostics: "diagnostics",
			enforce: "enforce",
			everyProviderUsed: "every provider is already in this chain",
			expand: "expand all",
			free: "free",
			globalShare: "global",
			inUse: "in use",
			limited: "limited",
			logEmpty: "nothing yet",
			models: "models",
			necessary: "when necessary",
			newChain: "new chain",
			open: "Open Balancer",
			pickProvider: "pick a provider first",
			provider: "provider",
			providers: "providers",
			refresh: "refresh",
			reset: "reset",
			targetHint: "compacts at the global share, or this model's own",
			title: "Balancer",
			use: "use",
		},
	},
	setup(ctx) {
		const [accounts, setAccounts] = createSignal<Account[]>([]);
		const [balancing, setBalancing] = createSignal(false);
		// The limit the balancer compacts at, as typed: a size in thousands or a
		// share of the declared 1M window. A model may override it with its own.
		const [globalLimit, setGlobalLimit] = createSignal("");
		const [globalLimitDraft, setGlobalLimitDraft] = createSignal("");
		// The room kept free below a model's window, as typed: a size in
		// thousands or a share like 10%. Empty means the built-in rule. The
		// enforcement choice says whether that room comes off every cut or only
		// where the limit has reached what the model holds.
		const [buffer, setBuffer] = createSignal("");
		const [bufferDraft, setBufferDraft] = createSignal("");
		const [bufferEnforce, setBufferEnforce] = createSignal("always");
		const [message, setMessage] = createSignal("");
		const [chains, setChains] = createSignal<Chain[]>([]);
		const [providers, setProviders] = createSignal<Provider[]>([]);
		// The row whose add form is open, plus what the user has picked in it.
		const [adding, setAdding] = createSignal("");
		const [addProvider, setAddProvider] = createSignal("");
		const [addModels, setAddModels] = createSignal<Models["models"]>([]);
		const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
		// The diagnostics block at the foot of the panel: the values, when they
		// were read, and the button that re-reads them. Folded until asked for,
		// so the panel opens on what it is for rather than on its own plumbing.
		const [diagOpen, setDiagOpen] = createSignal(false);
		// When every value on the panel was last read in full.
		const [lastRefreshed, setLastRefreshed] = createSignal(0);
		// What the balancer has actually done this run, newest last.
		const [logEntries, setLogEntries] = createSignal<LogEntry[]>([]);
		const [creating, setCreating] = createSignal(false);
		// Collapses the whole models section, not just the rows. Starts folded,
		// and rows and groups do too, so the panel opens compact.
		const [modelsOpen, setModelsOpen] = createSignal(false);
		const [collapsedGroups, setCollapsedGroups] = createSignal<
			Record<string, boolean>
		>({});
		const [createProvider, setCreateProvider] = createSignal("");
		const [createModels, setCreateModels] = createSignal<Models["models"]>([]);

		const refresh = async () => {
			try {
				const rpc = ctx.client.rpc(Balancer);
				const [status, list, rows, order, settings, room, log] =
					await Promise.all([
						rpc.status({}),
						rpc.list({}),
						rpc.chains({}),
						rpc.priority({}),
						rpc.contextLimit({}),
						rpc.contextBuffer({}),
						rpc.log({}),
					]);
				setBalancing((status as Status).balancing);
				setAccounts([...(list as Listed).accounts]);
				setLogEntries([...(log as { entries: LogEntry[] }).entries]);
				setChains([...(rows as Chains).rows]);
				setProviders([...(order as Providers).entries]);
				setGlobalLimit((settings as ContextState).value);
				setGlobalLimitDraft((settings as ContextState).value);
				setBuffer((room as BufferState).value);
				setBufferDraft((room as BufferState).value);
				setBufferEnforce(
					(room as BufferState).enforce === "necessary"
						? "necessary"
						: "always",
				);
				setLastRefreshed(Date.now());
			} catch (error) {
				setMessage(describe(error));
			}
		};

		// "in use" is the account the router is pointed at right now, and the log
		// grows as requests move and fail over. Only those two are re-read, so a
		// poll cannot overwrite a field being typed into.
		const refreshInUse = async () => {
			try {
				const rpc = ctx.client.rpc(Balancer);
				const [list, log] = await Promise.all([rpc.list({}), rpc.log({})]);
				setAccounts([...(list as Listed).accounts]);
				setLogEntries([...(log as { entries: LogEntry[] }).entries]);
			} catch {
				// A poll that fails leaves the last good answer on screen.
			}
		};

		const run = async (action: () => Promise<unknown>) => {
			try {
				const reply = (await action()) as Reply;
				// The rows already show the result; only failures need words.
				setMessage(reply.ok ? "" : reply.message);
				await refresh();
			} catch (error) {
				setMessage(describe(error));
			}
		};

		const rpc = () => ctx.client.rpc(Balancer);

		const commitLimit = () => {
			if (globalLimitDraft() === globalLimit()) return;
			void run(() => rpc().setContextLimit({ value: globalLimitDraft() }));
		};

		// What a limit and a buffer work out to as an actual cut, by the same rule
		// the balancer uses, against the declared 1M — the window a model that
		// holds at least that much offers. A model that holds less is cut lower
		// still, which the limit field's title says.
		const cutFor = (limitText: string, bufferText: string, enforce: string) => {
			const limit = parseLimit(limitText);
			if (!limit.ok) return 0;
			const room = parseBuffer(bufferText);
			return effectiveThreshold({
				buffer: room.ok ? room.size : undefined,
				bufferEnforcement: enforce === "necessary" ? "necessary" : "always",
				globalLimit: limit.size,
			});
		};

		const cutTokens = () =>
			cutFor(globalLimitDraft(), bufferDraft(), bufferEnforce());

		const storedCut = () => cutFor(globalLimit(), buffer(), bufferEnforce());

		// What the buffer being typed works out to in tokens, for the readout
		// that confirms `20` means twenty thousand. A share has no single size,
		// so it shows none and the field's title explains what it measures.
		const bufferTokens = () => {
			const parsed = parseBuffer(bufferDraft());
			return parsed.ok && parsed.size && "tokens" in parsed.size
				? parsed.size.tokens
				: 0;
		};

		const commitBuffer = () => {
			if (bufferDraft() === buffer()) return;
			void run(() => rpc().setContextBuffer({ value: bufferDraft() }));
		};

		const startAdd = async (key: string) => {
			setAdding(key);
			setAddProvider("");
			setAddModels([]);
		};

		// The picker's model list comes from the server, which only offers models
		// the provider can actually route.
		const chooseProvider = async (providerID: string) => {
			setAddProvider(providerID);
			setAddModels([]);
			if (!providerID) return;
			try {
				const reply = (await rpc().chainModels({ providerID })) as Models;
				setAddModels(sortByName(reply.models));
			} catch (error) {
				setMessage(describe(error));
			}
		};

		const chooseCreateProvider = async (providerID: string) => {
			setCreateProvider(providerID);
			setCreateModels([]);
			if (!providerID) return;
			try {
				const reply = (await rpc().chainModels({ providerID })) as Models;
				setCreateModels(sortByName(reply.models));
			} catch (error) {
				setMessage(describe(error));
			}
		};

		// The panel lists rows that actually triage between providers, plus any
		// row the user built by hand. Everything else is noise.
		// Multi-provider rows and hand-built ones, read alphabetically: the
		// catalogue order is whatever the connectors happened to report.
		const visibleChains = () =>
			chains()
				.filter((chain) => chain.stored || chain.targets.length > 1)
				.sort((a, b) =>
					a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
				);

		// A row holds one target per provider, so a provider it already routes to
		// cannot be added again.
		const addableProviders = (chain: Chain) =>
			providers().filter(
				(entry) =>
					!chain.targets.some(
						(target) => target.providerID === entry.providerID,
					),
			);

		// Rows gather under the brand their label starts with, so Claude and
		// DeepSeek rows sit together instead of interleaving alphabetically.
		const groupedChains = () => groupByBrand(visibleChains());

		const isGroupCollapsed = (name: string) =>
			collapsedGroups()[name] !== false;
		const toggleGroup = (name: string) =>
			setCollapsedGroups({
				...collapsedGroups(),
				[name]: !isGroupCollapsed(name),
			});

		const isCollapsed = (key: string) => collapsed()[key] !== false;
		const toggleCollapsed = (key: string) =>
			setCollapsed({ ...collapsed(), [key]: !isCollapsed(key) });

		// Collapse all flips the whole list at once, so a long catalogue is one
		// click away from a single screen of headers.
		const allCollapsed = () => {
			const rows = visibleChains();
			return rows.length > 0 && rows.every((chain) => isCollapsed(chain.key));
		};
		const toggleAll = () => {
			const collapse = !allCollapsed();
			const rows: Record<string, boolean> = {};
			for (const chain of visibleChains()) rows[chain.key] = collapse;
			const groups: Record<string, boolean> = {};
			for (const group of groupedChains()) {
				if (group.brand) groups[group.brand] = collapse;
			}
			setCollapsed(rows);
			setCollapsedGroups(groups);
		};

		const row = {
			"align-items": "center",
			display: "flex",
			"flex-wrap": "wrap",
			gap: "6px",
		} as const;
		// A submenu's contents sit one step in from the row that owns them. At the
		// same left edge, an expanded row's targets read as siblings of their own
		// header instead of as what is inside it, which is what made the models
		// list hard to scan. The step matches the width of a fold button.
		const stair = (depth: number) =>
			({
				display: "flex",
				"flex-direction": "column",
				gap: "4px",
				"padding-left": `${depth * 1.4}em`,
			}) as const;
		// Narrow panels must wrap instead of pushing controls off the edge.
		const field = { flex: "1 1 120px", "min-width": 0 } as const;
		// A hairline between segments, drawn in the text colour so it follows
		// the theme rather than assuming a light or dark background.
		const divider = {
			"border-top": "1px solid currentColor",
			height: 0,
			opacity: 0.15,
		} as const;

		// The providers section is one row per credential, in the balancer's
		// order: the order, the switches and the arrows all act on the
		// credential, so nothing rides a provider header row.
		const providerEntries = () =>
			providers().map((entry) => ({
				account: accounts().find(
					(account) =>
						account.providerID === entry.providerID &&
						account.alias === entry.alias,
				),
				entry,
			}));

		const View = () => {
			onMount(() => {
				void refresh();
				const timer = setInterval(() => void refreshInUse(), 2000);
				onCleanup(() => clearInterval(timer));
			});
			return (
				<div
					style={{
						display: "flex",
						"flex-direction": "column",
						"font-size": "13px",
						gap: "8px",
						height: "100%",
						"min-height": 0,
						"overflow-y": "auto",
						"overscroll-behavior": "contain",
						padding: "12px",
					}}
				>
					<div style={row}>
						<strong>{ctx.t("title")}</strong>
						<label
							style={{ display: "flex", gap: "4px", "margin-left": "auto" }}
							title="route each request across the providers automatically. Off leaves every request on the credential OpenCode itself picked, so the balancer only reports."
						>
							<input
								checked={balancing()}
								onChange={(event) =>
									void run(() =>
										rpc().setBalancing({
											enabled: event.currentTarget.checked,
										}),
									)
								}
								type="checkbox"
							/>
							{ctx.t("balancing")}
						</label>
					</div>

					<div style={divider} />

					<div style={row}>
						<span
							style={{ opacity: 0.7 }}
							title="The limit the balancer compacts a conversation at, and what that works out to after the buffer comes off — the number at the end of the line. A size in thousands — 200 is two hundred thousand — or a share of the 1M window every balancer model declares, like 20%. Empty keeps the built-in 20%. A model can override it with a limit of its own."
						>
							{ctx.t("contextLimit")}
						</span>
						<input
							onBlur={commitLimit}
							onInput={(event) =>
								setGlobalLimitDraft(event.currentTarget.value)
							}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							placeholder="200"
							style={{ width: "4.5em" }}
							title="a size in thousands — 200 is two hundred thousand — or a share of the 1M window every balancer model declares, like 20%; empty restores the default"
							value={globalLimitDraft()}
						/>
						{/* The room to keep free: what makes a model whose real cap is
						    below what it reports compact before it is refused, rather
						    than on its last token. */}
						<span
							style={{ opacity: 0.7 }}
							title="the room kept free below the cut, so compacting never lands on the model's last token. A size in thousands — 0.5 is five hundred — or a share of the limit, like 5%. Empty keeps the built-in rule: a tenth of the limit or 20k, whichever is larger."
						>
							{ctx.t("buffer")}
						</span>
						<input
							onBlur={commitBuffer}
							onInput={(event) => setBufferDraft(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							placeholder="20"
							style={{ width: "4.5em" }}
							title="the room kept free below the cut, so compacting never lands on the model's last token. A size in thousands — 0.5 is five hundred — or a share of the limit, like 5%. Empty keeps the built-in rule: a tenth of the limit or 20k, whichever is larger."
							value={bufferDraft()}
						/>
						{/* `20` meaning twenty thousand is worth confirming, since
						    the field above it takes a share as readily. */}
						<Show when={bufferTokens() > 0}>
							<span
								style={{ opacity: 0.6 }}
								title="what the buffer works out to"
							>
								{formatTokens(bufferTokens())}
							</span>
						</Show>
						{/* Whether that room comes off a limit that already leaves
						    plenty: the user's call, since only a limit that has run
						    into the model needs it. The label and its dropdown are one
						    item so a wrap can never strand one on the line above the
						    other. */}
						<span
							style={{
								"align-items": "center",
								display: "flex",
								gap: "4px",
								"white-space": "nowrap",
							}}
						>
							<span
								style={{ opacity: 0.7 }}
								title="when the buffer is enforced. `always` takes it off every cut; `when necessary` takes it only where the limit has reached what the model can hold, so a limit that already leaves room stands alone. At least that much is always kept, so a cut never lands on the model's last token."
							>
								{ctx.t("enforce")}
							</span>
							<select
								onChange={(event) =>
									void run(() =>
										rpc().setBufferEnforce({
											value: event.currentTarget.value,
										}),
									)
								}
								style={{ "font-size": "inherit", width: "10.5em" }}
								title="when the buffer is enforced: always takes it off every cut, when necessary only where the limit has reached what the model can hold"
								value={bufferEnforce()}
							>
								<option value="always">{ctx.t("always")}</option>
								<option value="necessary">{ctx.t("necessary")}</option>
							</select>
						</span>
						{/* What the three fields to its left work out to, at the end
						    of the line: a bare number between them read as belonging
						    to neither. */}
						<Show when={cutTokens() > 0}>
							<span
								style={{ opacity: 0.6 }}
								title="what this cuts at: the limit, less the buffer where the buffer is enforced. A model whose real window is smaller is cut below this, and one whose window is unknown is measured against the declared 1M."
							>
								{formatTokens(cutTokens())}
							</span>
						</Show>
					</div>

					<Show when={message()}>
						<div style={{ opacity: 0.7 }}>{message()}</div>
					</Show>

					<div style={divider} />

					<div style={row}>
						<strong title="one row per credential, in the order routing tries them. active = the balancer can send here; in use = served the last request; limited = parked after a failure — hover a marker for the reason. Two credentials on one provider are two rows, and each is tried in turn.">
							{ctx.t("providers")}
						</strong>
					</div>

					<For each={providerEntries()}>
						{(item, index) => (
							<div style={row}>
								<label
									style={{ display: "flex", gap: "4px" }}
									title="route to this credential; a disabled one is never chosen"
								>
									<input
										checked={item.entry.enabled}
										onChange={(event) =>
											void run(() =>
												rpc().setEnabled({
													alias: item.entry.alias,
													enabled: event.currentTarget.checked,
													providerID: item.entry.providerID,
												}),
											)
										}
										type="checkbox"
									/>
									<span style={field}>
										{`${item.entry.name} / ${item.entry.alias}`}
										<Show when={item.account}>
											{(account) => (
												<>
													{account().inUse
														? ` · ${ctx.t("inUse")}`
														: account().active
															? ` · ${ctx.t("active")}`
															: ""}
													<Show when={account().limited}>
														<span title={account().limitedReason || undefined}>
															{` · ${ctx.t("limited")}`}
														</span>
													</Show>
												</>
											)}
										</Show>
									</span>
								</label>
								<label
									style={{ display: "flex", gap: "4px" }}
									title="use only this credential's free models"
								>
									<input
										checked={item.entry.freeOnly}
										onChange={(event) =>
											void run(() =>
												rpc().setFreeOnly({
													alias: item.entry.alias,
													enabled: event.currentTarget.checked,
													providerID: item.entry.providerID,
												}),
											)
										}
										type="checkbox"
									/>
									{ctx.t("free")}
								</label>
								<button
									disabled={index() === 0}
									onClick={() =>
										void run(() =>
											rpc().move({
												alias: item.entry.alias,
												direction: "up",
												providerID: item.entry.providerID,
											}),
										)
									}
									title="try this credential sooner"
								>
									↑
								</button>
								<button
									disabled={index() === providers().length - 1}
									onClick={() =>
										void run(() =>
											rpc().move({
												alias: item.entry.alias,
												direction: "down",
												providerID: item.entry.providerID,
											}),
										)
									}
									title="try this credential later"
								>
									↓
								</button>
								<button
									onClick={() =>
										void run(() =>
											rpc().use({
												alias: item.entry.alias,
												providerID: item.entry.providerID,
											}),
										)
									}
									title="serve this provider with this credential; picking a parked one clears its cooldown"
								>
									{ctx.t("use")}
								</button>
							</div>
						)}
					</For>

					<div style={divider} />

					<div style={{ ...row, "margin-top": "4px" }}>
						<button
							onClick={() => setModelsOpen(!modelsOpen())}
							style={{ "min-width": "1.4em" }}
							title={modelsOpen() ? ctx.t("collapse") : ctx.t("expand")}
						>
							{modelsOpen() ? "▾" : "▸"}
						</button>
						<strong>{ctx.t("models")}</strong>
						<button
							onClick={() => {
								setCreating(!creating());
								setCreateProvider("");
								setCreateModels([]);
							}}
							style={{ "margin-left": "auto" }}
						>
							+ {ctx.t("newChain")}
						</button>
						<button
							onClick={toggleAll}
							title={allCollapsed() ? ctx.t("expand") : ctx.t("collapse")}
						>
							{allCollapsed() ? ctx.t("expand") : ctx.t("collapse")}
						</button>
					</div>

					<Show when={modelsOpen()}>
						<Show when={creating()}>
							<div style={row}>
								<select
									onChange={(event) =>
										void chooseCreateProvider(event.currentTarget.value)
									}
									style={field}
									value={createProvider()}
								>
									<option value="">provider</option>
									<For each={providers()}>
										{(entry) => (
											<option value={entry.providerID}>{entry.name}</option>
										)}
									</For>
								</select>
								<select
									onChange={(event) =>
										void run(() =>
											rpc().chainCreate({
												modelID: event.currentTarget.value,
												providerID: createProvider(),
											}),
										).then(() => setCreating(false))
									}
									style={field}
									value=""
								>
									<option value="">model</option>
									<For each={createModels()}>
										{(model) => (
											<option value={model.modelID}>{model.name}</option>
										)}
									</For>
								</select>
							</div>
						</Show>

						{/* Each category sits one step in from the `models` heading, its
						    rows one step in again, and a row's targets one step in from
						    that: section, category, row, target. */}
						<For each={groupedChains()}>
							{(group) => (
								<div style={stair(1)}>
									<Show when={group.brand}>
										<div style={{ ...row, "margin-top": "4px" }}>
											<button
												onClick={() => toggleGroup(group.brand ?? "")}
												style={{ "min-width": "1.4em" }}
												title={
													isGroupCollapsed(group.brand ?? "")
														? ctx.t("expand")
														: ctx.t("collapse")
												}
											>
												{isGroupCollapsed(group.brand ?? "") ? "▸" : "▾"}
											</button>
											<strong>{group.brand}</strong>
											<span style={{ opacity: 0.6 }}>{group.rows.length}</span>
										</div>
									</Show>
									<Show when={!isGroupCollapsed(group.brand ?? "")}>
										<div style={stair(1)}>
											<For each={group.rows}>
												{(chain) => (
													<div
														style={{
															"border-top": "1px solid rgba(128,128,128,0.25)",
															display: "flex",
															"flex-direction": "column",
															gap: "4px",
															"padding-top": "6px",
														}}
													>
														<div style={row}>
															<button
																onClick={() => toggleCollapsed(chain.key)}
																style={{ "min-width": "1.4em" }}
																title={
																	isCollapsed(chain.key) ? "expand" : "collapse"
																}
															>
																{isCollapsed(chain.key) ? "▸" : "▾"}
															</button>
															<span
																style={{
																	flex: "1 1 140px",
																	"min-width": 0,
																	"overflow-wrap": "anywhere",
																}}
															>
																{chain.label}
															</span>
															<span style={{ opacity: 0.6 }}>
																{chain.targets.length} ·{" "}
																{chain.stored ? "custom" : "automatic"}
															</span>
															{/* The model's own limit, on the model's own
															    row: it applies wherever the request is
															    served from, so it does not belong on a
															    provider line or to any one of them. */}
															<input
																onBlur={(event) => {
																	const value = event.currentTarget.value;
																	void run(() =>
																		rpc().setModelLimit({
																			key: chain.key,
																			value,
																		}),
																	);
																}}
																onKeyDown={(event) => {
																	if (event.key === "Enter")
																		event.currentTarget.blur();
																}}
																placeholder={ctx.t("globalShare")}
																style={{ width: "5em" }}
																title={`this model's own limit: a size in thousands — 200 is two hundred thousand — or a share of its real window, 1% to ${MAX_PERCENT}%; empty follows the global limit`}
																value={chain.limit}
															/>
															<Show when={chain.stored}>
																<button
																	onClick={() =>
																		void run(() =>
																			rpc().chainReset({ key: chain.key }),
																		)
																	}
																>
																	{ctx.t("reset")}
																</button>
															</Show>
														</div>

														<Show when={!isCollapsed(chain.key)}>
															<div style={stair(1)}>
																<For each={chain.targets}>
																	{(target, index) => (
																		<div style={row}>
																			<span
																				style={{
																					flex: "1 1 140px",
																					"min-width": 0,
																					"overflow-wrap": "anywhere",
																				}}
																			>
																				{index() + 1}. {target.providerID} ·{" "}
																				{target.modelID}
																				<Show
																					when={
																						target.resolved &&
																						target.resolved !== target.modelID
																					}
																				>
																					<span style={{ opacity: 0.6 }}>
																						{" "}
																						→ {target.resolved}
																					</span>
																				</Show>
																				<Show when={target.state === "next"}>
																					<span style={{ opacity: 0.6 }}>
																						{" "}
																						· next
																					</span>
																				</Show>
																				<Show
																					when={
																						target.state !== "next" &&
																						target.state !== "available"
																					}
																				>
																					<span style={{ opacity: 0.6 }}>
																						{" "}
																						· {target.state}
																					</span>
																				</Show>
																			</span>
																			<button
																				disabled={index() === 0}
																				onClick={() =>
																					void run(() =>
																						rpc().chainMove({
																							direction: "up",
																							key: chain.key,
																							providerID: target.providerID,
																						}),
																					)
																				}
																				title="move up"
																			>
																				↑
																			</button>
																			<button
																				disabled={
																					index() === chain.targets.length - 1
																				}
																				onClick={() =>
																					void run(() =>
																						rpc().chainMove({
																							direction: "down",
																							key: chain.key,
																							providerID: target.providerID,
																						}),
																					)
																				}
																				title="move down"
																			>
																				↓
																			</button>
																			<button
																				onClick={() =>
																					void run(() =>
																						rpc().chainRemove({
																							key: chain.key,
																							providerID: target.providerID,
																						}),
																					)
																				}
																				title="remove target"
																			>
																				×
																			</button>
																		</div>
																	)}
																</For>

																<div style={{ opacity: 0.6 }}>
																	{ctx.t("targetHint")}
																</div>

																<Show
																	fallback={
																		<button
																			disabled={
																				addableProviders(chain).length === 0
																			}
																			onClick={() => void startAdd(chain.key)}
																			title={
																				addableProviders(chain).length === 0
																					? ctx.t("everyProviderUsed")
																					: undefined
																			}
																		>
																			+ {ctx.t("addTarget")}
																		</button>
																	}
																	when={adding() === chain.key}
																>
																	<Show
																		fallback={
																			<div style={row}>
																				<span style={{ opacity: 0.6 }}>
																					{ctx.t("everyProviderUsed")}
																				</span>
																				<button onClick={() => setAdding("")}>
																					cancel
																				</button>
																			</div>
																		}
																		when={addableProviders(chain).length > 0}
																	>
																		<div style={row}>
																			<select
																				onChange={(event) =>
																					void chooseProvider(
																						event.currentTarget.value,
																					)
																				}
																				style={field}
																				value={addProvider()}
																			>
																				<option value="">provider</option>
																				<For each={addableProviders(chain)}>
																					{(entry) => (
																						<option value={entry.providerID}>
																							{entry.name}
																						</option>
																					)}
																				</For>
																			</select>
																			<select
																				disabled={!addProvider()}
																				onChange={(event) =>
																					void (async () => {
																						await run(() =>
																							rpc().chainAdd({
																								key: chain.key,
																								modelID:
																									event.currentTarget.value,
																								providerID: addProvider(),
																							}),
																						);
																						setAdding("");
																					})()
																				}
																				style={field}
																				value=""
																			>
																				<option value="">
																					{addProvider()
																						? addModels().length > 0
																							? "model"
																							: "no models to add"
																						: ctx.t("pickProvider")}
																				</option>
																				<For each={addModels()}>
																					{(model) => (
																						<option value={model.modelID}>
																							{model.name}
																						</option>
																					)}
																				</For>
																			</select>
																			<button onClick={() => setAdding("")}>
																				cancel
																			</button>
																		</div>
																	</Show>
																</Show>
															</div>
														</Show>
													</div>
												)}
											</For>
										</div>
									</Show>
								</div>
							)}
						</For>
					</Show>

					<div style={divider} />

					{/* Diagnostics: the panel's own plumbing — what is loaded, when it
					    was read, and what the balancer has done this run. Folded away
					    so the top of the panel is the state, not the tools. */}
					<div style={{ ...row, "align-items": "center" }}>
						<button onClick={() => setDiagOpen(!diagOpen())}>
							{diagOpen() ? "▾" : "▸"} {ctx.t("diagnostics")}
						</button>
						<span style={{ opacity: 0.5 }}>{logEntries().length}</span>
						<button
							onClick={() => void refresh()}
							style={{ "margin-left": "auto" }}
							title="re-read every value on this panel from the balancer"
						>
							{ctx.t("refresh")}
						</button>
					</div>
					<Show when={diagOpen()}>
						<div
							style={{
								"border-top": "1px solid currentColor",
								display: "flex",
								"flex-direction": "column",
								gap: "4px",
								"padding-top": "4px",
							}}
						>
							<div
								style={{
									display: "flex",
									"flex-direction": "column",
									"font-family": "ui-monospace, monospace",
									"font-size": "11px",
									gap: "2px",
									opacity: 0.8,
								}}
							>
								<span title="the panel bundle in use; reload the window to pick up a newer build">
									build {builtAt()}
								</span>
								<span title="when every value here was last read in full; the credential list and the log also follow along every couple of seconds">
									values{" "}
									{lastRefreshed()
										? new Date(lastRefreshed()).toLocaleTimeString()
										: "not read yet"}
								</span>
								<span>
									{providerEntries().length} credentials ·{" "}
									{visibleChains().length} rows · {logEntries().length} log
									lines
								</span>
								<span>
									context limit {globalLimit() || "default"} ·{" "}
									{formatTokens(storedCut())}
								</span>
							</div>
							<Show when={logEntries().length > 0}>
								<button
									onClick={() => void run(() => rpc().clearLog({}))}
									style={{ "align-self": "flex-start" }}
								>
									{ctx.t("clear")}
								</button>
							</Show>
							{/* What the balancer has actually done this run, under the
							    values it is asked about: one place to look, not two. */}
							<div
								style={{
									"border-top": "1px solid currentColor",
									"font-family": "ui-monospace, monospace",
									"font-size": "11px",
									"max-height": "180px",
									"min-height": 0,
									"overflow-y": "auto",
									"padding-top": "4px",
									"white-space": "pre-wrap",
								}}
							>
								<For
									each={logEntries()}
									fallback={
										<span style={{ opacity: 0.5 }}>{ctx.t("logEmpty")}</span>
									}
								>
									{(entry) => (
										<div
											style={{ opacity: entry.kind === "route" ? 1 : 0.75 }}
											title={entry.kind}
										>
											<span style={{ opacity: 0.5 }}>
												{new Date(entry.at).toLocaleTimeString()}{" "}
											</span>
											{entry.text}
										</div>
									)}
								</For>
							</div>
						</div>
					</Show>
				</div>
			);
		};

		const tab: PanelTab = {
			fallback: true,
			id: "accounts",
			pinned: true,
			get title() {
				return ctx.t("title");
			},
		};

		const openPanel = () => {
			const session = ctx.sessions.current() ?? ctx.sessions.list()[0];
			if (session) ctx.layout.open(`${ctx.id}:accounts`, session);
		};

		// Always listed: the tab is pinned, so it shows in the side strip without
		// the user having opened it first.
		ctx.add(Panel, {
			id: "accounts",
			list: () => [tab],
			mobile: {
				kind: "menu",
				order: 40,
				get title() {
					return ctx.t("title");
				},
			},
			region: "side",
			render: () => <View />,
		});

		// The + menu and the tab strip only exist inside the side region, so the
		// always-visible titlebar pill is the entry point that cannot be missed.
		ctx.add(TitlebarItem, () => ({
			icon: "sliders" as const,
			id: "open",
			label: ctx.t("title"),
			run: openPanel,
			title: ctx.t("open"),
		}));

		// The + menu before the side panel tabs, so the panel is reachable even
		// when the side region is empty.
		ctx.add(MenuItem, () => ({
			icon: "sliders" as const,
			id: "open",
			menu: "session.panel" as const,
			order: 40,
			run: openPanel,
			title: ctx.t("title"),
		}));

		ctx.add(Command, () => ({
			featured: true as const,
			group: ctx.t("title"),
			id: "open",
			keywords: "balancer accounts providers failover panel",
			run: openPanel,
			title: ctx.t("open"),
		}));

		// `/balancer gui` runs on the server, which cannot touch the layout, so
		// it emits this event instead and the window opens the panel here.
		const stop = ctx.client
			.rpc(Balancer)
			.events.on("open", openPanel, { signal: ctx.signal });

		return () => stop();
	},
});
