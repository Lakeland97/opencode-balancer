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
import { DECLARED_CONTEXT } from "./core/context";
import { groupByBrand } from "./core/models";
import { Balancer } from "./rpc";

type LogEntry = { at: number; kind: string; text: string };

type Account = {
	providerID: string;
	alias: string;
	/** The stored default for this provider. */
	active: boolean;
	/** What would authorise the next request, fallback included. */
	inUse: boolean;
	disabled: boolean;
	limited: boolean;
	/** What the endpoint reported when it parked this account. */
	limitedReason?: string;
	failures: number;
};

type Status = { balancing: boolean };
type Listed = { accounts: Account[] };
type Reply = { ok: boolean; message: string };
type ContextState = { percent: number };

type Target = {
	modelID: string;
	providerID: string;
	/** What is actually sent, once a free-only provider substitutes. */
	resolved: string;
	state: string;
	/** This model's own share of its window, 0 when it follows the global. */
	percent: number;
};
type Chain = {
	key: string;
	label: string;
	package: string;
	stored: boolean;
	targets: Target[];
};
type Chains = { rows: Chain[] };
type Provider = {
	enabled: boolean;
	freeOnly: boolean;
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

/** A token count the way it is said aloud: 200000 reads as 200k, 1000000 as 1m. */
function size(value: number) {
	if (!Number.isFinite(value) || value <= 0) return "";
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`;
	}
	return `${Math.round(value / 1000)}k`;
}

export default Plugin.define({
	i18n: {
		en: {
			active: "active",
			addTarget: "add target",
			apply: "apply",
			balancing: "balancing",
			clear: "clear",
			collapse: "collapse all",
			contextLimit: "context share",
			disabled: "disabled",
			everyProviderUsed: "every provider is already in this chain",
			expand: "expand all",
			free: "free",
			globalShare: "global",
			inUse: "in use",
			limited: "limited",
			log: "log",
			logEmpty: "nothing yet",
			models: "models",
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
		// The share of the declared 1M window the balancer compacts at, and the
		// field being typed into. A model may override it with its own share.
		const [globalPercent, setGlobalPercent] = createSignal(20);
		const [globalDraft, setGlobalDraft] = createSignal("20");
		const [message, setMessage] = createSignal("");
		const [chains, setChains] = createSignal<Chain[]>([]);
		const [providers, setProviders] = createSignal<Provider[]>([]);
		// The row whose add form is open, plus what the user has picked in it.
		const [adding, setAdding] = createSignal("");
		const [addProvider, setAddProvider] = createSignal("");
		const [addModels, setAddModels] = createSignal<Models["models"]>([]);
		const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
		// What the balancer has actually done this run, newest last.
		const [logEntries, setLogEntries] = createSignal<LogEntry[]>([]);
		const [logOpen, setLogOpen] = createSignal(false);
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
				const [status, list, rows, order, settings, log] = await Promise.all([
					rpc.status({}),
					rpc.list({}),
					rpc.chains({}),
					rpc.priority({}),
					rpc.contextPercent({}),
					rpc.log({}),
				]);
				setBalancing((status as Status).balancing);
				setAccounts([...(list as Listed).accounts]);
				setLogEntries([...(log as { entries: LogEntry[] }).entries]);
				setChains([...(rows as Chains).rows]);
				setProviders([...(order as Providers).entries]);
				setGlobalPercent((settings as ContextState).percent);
				setGlobalDraft(String((settings as ContextState).percent));
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

		// What the share being typed works out to. The global share is a slice
		// of the 1M every balancer model declares, so this arithmetic is the
		// whole story for a 1M model; a model whose real window is smaller is
		// clamped to that window instead, which the field's title says. Read
		// from the draft rather than the stored value, so the number follows
		// the field as it is typed.
		const draftTokens = () => {
			const typed = globalDraft().replace("%", "").trim();
			if (typed === "") return 0;
			const percent = Number(typed);
			if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return 0;
			return Math.round((DECLARED_CONTEXT * percent) / 100);
		};

		const commitPercent = () => {
			if (globalDraft() === String(globalPercent())) return;
			void run(() => rpc().setContextPercent({ value: globalDraft() }));
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
		// Narrow panels must wrap instead of pushing controls off the edge.
		const field = { flex: "1 1 120px", "min-width": 0 } as const;
		// A hairline between segments, drawn in the text colour so it follows
		// the theme rather than assuming a light or dark background.
		const divider = {
			"border-top": "1px solid currentColor",
			height: 0,
			opacity: 0.15,
		} as const;

		// The providers section reads as one entry per credential: a provider
		// contributes a row for every credential OpenCode holds for it, and its
		// own settings (enabled, free-only, priority) ride the first of those
		// rows. A provider with no imported credential still gets one row, so
		// its settings stay reachable.
		const providerEntries = () => {
			const entries: {
				account?: Account;
				first: boolean;
				index: number;
				provider: Provider;
			}[] = [];
			providers().forEach((provider, index) => {
				const mine = accounts().filter(
					(account) => account.providerID === provider.providerID,
				);
				if (mine.length === 0) {
					entries.push({ first: true, index, provider });
					return;
				}
				mine.forEach((account, position) => {
					entries.push({ account, first: position === 0, index, provider });
				});
			});
			return entries;
		};

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
						<button onClick={() => void refresh()}>{ctx.t("refresh")}</button>
						<span
							style={{ "font-size": "11px", opacity: 0.4 }}
							title="panel build"
						>
							{typeof __BALANCER_BUILT_AT__ === "string"
								? __BALANCER_BUILT_AT__
								: "dev"}
						</span>
					</div>

					<div style={divider} />

					<div style={row}>
						<span
							style={{ opacity: 0.7 }}
							title="The share of the declared 1M window the balancer compacts a conversation at. It compacts itself, so this is what actually trips; a model can override it with its own share of its real window."
						>
							{ctx.t("contextLimit")}
						</span>
						<span
							style={{ "align-items": "center", display: "flex", gap: "4px" }}
						>
							<input
								onBlur={commitPercent}
								onInput={(event) => setGlobalDraft(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
								}}
								placeholder="20"
								style={{ width: "3.5em" }}
								title="a share from 1% to 100% of the 1M window every balancer model declares; empty restores the default"
								value={globalDraft()}
							/>
							<span style={{ opacity: 0.7 }}>%</span>
							<Show when={draftTokens() > 0}>
								<span
									style={{ opacity: 0.6 }}
									title="what this share works out to: the share of the declared 1M the balancer compacts at. A model whose real window is smaller is compacted at that smaller window instead."
								>
									= {size(draftTokens())}
								</span>
							</Show>
						</span>
					</div>

					<Show when={message()}>
						<div style={{ opacity: 0.7 }}>{message()}</div>
					</Show>

					<div style={divider} />

					<div style={row}>
						<strong>{ctx.t("providers")}</strong>
					</div>

					<For each={providerEntries()}>
						{(entry) => (
							<div style={row}>
								<Show
									fallback={<span style={{ width: "1.4em" }} />}
									when={entry.first}
								>
									<input
										checked={entry.provider.enabled}
										onChange={(event) =>
											void run(() =>
												rpc().setEnabled({
													enabled: event.currentTarget.checked,
													providerID: entry.provider.providerID,
												}),
											)
										}
										type="checkbox"
									/>
								</Show>
								<span style={field}>
									{entry.account
										? `${entry.provider.name} / ${entry.account.alias}`
										: entry.provider.name}
									<Show when={entry.account}>
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
												{account().disabled ? ` · ${ctx.t("disabled")}` : ""}
											</>
										)}
									</Show>
								</span>
								<Show when={entry.first}>
									<label
										style={{ display: "flex", gap: "4px" }}
										title="use only this provider's free models"
									>
										<input
											checked={entry.provider.freeOnly}
											onChange={(event) =>
												void run(() =>
													rpc().setFreeOnly({
														enabled: event.currentTarget.checked,
														providerID: entry.provider.providerID,
													}),
												)
											}
											type="checkbox"
										/>
										{ctx.t("free")}
									</label>
									<button
										disabled={entry.index === 0}
										onClick={() =>
											void run(() =>
												rpc().move({
													direction: "up",
													providerID: entry.provider.providerID,
												}),
											)
										}
									>
										↑
									</button>
									<button
										disabled={entry.index === providers().length - 1}
										onClick={() =>
											void run(() =>
												rpc().move({
													direction: "down",
													providerID: entry.provider.providerID,
												}),
											)
										}
									>
										↓
									</button>
								</Show>
								<Show when={entry.account}>
									{(account) => (
										<button
											onClick={() =>
												void run(() =>
													rpc().use({
														alias: account().alias,
														providerID: account().providerID,
													}),
												)
											}
											title="send this provider's calls here; picking a parked account clears its cooldown"
										>
											{ctx.t("use")}
										</button>
									)}
								</Show>
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

						<For each={groupedChains()}>
							{(group) => (
								<div
									style={{
										display: "flex",
										"flex-direction": "column",
										gap: "4px",
									}}
								>
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
																	<input
																		inputMode="numeric"
																		onBlur={(event) => {
																			const value = event.currentTarget.value;
																			void run(() =>
																				rpc().setTargetPercent({
																					key: chain.key,
																					providerID: target.providerID,
																					value,
																				}),
																			);
																		}}
																		onKeyDown={(event) => {
																			if (event.key === "Enter")
																				event.currentTarget.blur();
																		}}
																		placeholder={ctx.t("globalShare")}
																		style={{ width: "6em" }}
																		title="this model's own share of its real window, 1% to 100%; empty follows the global share"
																		value={
																			target.percent
																				? String(target.percent)
																				: ""
																		}
																	/>
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
																						modelID: event.currentTarget.value,
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
													</Show>
												</div>
											)}
										</For>
									</Show>
								</div>
							)}
						</For>
					</Show>

					<div style={divider} />
					<div style={{ ...row, "align-items": "center" }}>
						<button onClick={() => setLogOpen(!logOpen())}>
							{logOpen() ? "▾" : "▸"} {ctx.t("log")}
						</button>
						<span style={{ opacity: 0.5 }}>{logEntries().length}</span>
						<Show when={logOpen() && logEntries().length > 0}>
							<button onClick={() => void run(() => rpc().clearLog({}))}>
								{ctx.t("clear")}
							</button>
						</Show>
					</div>
					<Show when={logOpen()}>
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
