/** @jsxImportSource solid-js */

import {
	Command,
	MenuItem,
	Panel,
	type PanelTab,
	Plugin,
	TitlebarItem,
} from "@opencode/plugin/gui";
import { createSignal, For, onMount, Show } from "solid-js";
import { Balancer } from "./rpc";

type Account = {
	providerID: string;
	alias: string;
	/** The stored default for this provider. */
	active: boolean;
	/** What would authorise the next request, fallback included. */
	inUse: boolean;
	disabled: boolean;
	limited: boolean;
	failures: number;
};

type Status = { balancing: boolean };
type Listed = { accounts: Account[] };
type Reply = { ok: boolean; message: string };

type Target = { modelID: string; providerID: string; state: string };
type Chain = {
	context: number;
	declaredContext: number;
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

/** Compact window size: 200000 becomes 200k, 1000000 becomes 1m. */
function size(value: number) {
	if (!value) return "?";
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
			add: "add",
			addTarget: "add target",
			alias: "alias",
			balancing: "balancing",
			declares: "declares",
			disabled: "disabled",
			free: "free",
			inUse: "in use",
			limited: "limited",
			models: "models",
			newChain: "new chain",
			open: "Open Balancer",
			provider: "provider",
			providers: "providers",
			refresh: "refresh",
			remove: "remove",
			reset: "reset",
			title: "Balancer",
			use: "use",
			window: "window",
		},
	},
	setup(ctx) {
		const [accounts, setAccounts] = createSignal<Account[]>([]);
		const [balancing, setBalancing] = createSignal(false);
		const [message, setMessage] = createSignal("");
		const [provider, setProvider] = createSignal("");
		const [alias, setAlias] = createSignal("");
		const [chains, setChains] = createSignal<Chain[]>([]);
		const [providers, setProviders] = createSignal<Provider[]>([]);
		// The row whose add form is open, plus what the user has picked in it.
		const [adding, setAdding] = createSignal("");
		const [addProvider, setAddProvider] = createSignal("");
		const [addModels, setAddModels] = createSignal<Models["models"]>([]);
		const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
		const [creating, setCreating] = createSignal(false);
		const [createProvider, setCreateProvider] = createSignal("");
		const [createModels, setCreateModels] = createSignal<Models["models"]>([]);

		const refresh = async () => {
			try {
				const rpc = ctx.client.rpc(Balancer);
				const [status, list, rows, order] = await Promise.all([
					rpc.status({}),
					rpc.list({}),
					rpc.chains({}),
					rpc.priority({}),
				]);
				setBalancing((status as Status).balancing);
				setAccounts([...(list as Listed).accounts]);
				setChains([...(rows as Chains).rows]);
				setProviders([...(order as Providers).entries]);
			} catch (error) {
				setMessage(describe(error));
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
				setAddModels(reply.models);
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
				setCreateModels(reply.models);
			} catch (error) {
				setMessage(describe(error));
			}
		};

		// The panel lists rows that actually triage between providers, plus any
		// row the user built by hand. Everything else is noise.
		const visibleChains = () =>
			chains().filter((chain) => chain.stored || chain.targets.length > 1);

		const isCollapsed = (key: string) => Boolean(collapsed()[key]);
		const toggleCollapsed = (key: string) =>
			setCollapsed({ ...collapsed(), [key]: !collapsed()[key] });

		const row = {
			"align-items": "center",
			display: "flex",
			"flex-wrap": "wrap",
			gap: "6px",
		} as const;
		// Narrow panels must wrap instead of pushing controls off the edge.
		const field = { flex: "1 1 120px", "min-width": 0 } as const;

		const View = () => {
			onMount(() => void refresh());
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
					</div>

					<Show when={message()}>
						<div style={{ opacity: 0.7 }}>{message()}</div>
					</Show>

					<For each={accounts()}>
						{(account) => (
							<div style={row}>
								<span
									style={{
										flex: "1 1 140px",
										"min-width": 0,
										"overflow-wrap": "anywhere",
									}}
								>
									{account.providerID}/{account.alias}
									{account.inUse
										? ` · ${ctx.t("inUse")}`
										: account.active
											? ` · ${ctx.t("active")}`
											: ""}
									{account.limited ? ` · ${ctx.t("limited")}` : ""}
									{account.disabled ? ` · ${ctx.t("disabled")}` : ""}
								</span>
								<Show when={!account.inUse}>
									<button
										onClick={() =>
											void run(() =>
												rpc().use({
													alias: account.alias,
													providerID: account.providerID,
												}),
											)
										}
									>
										{ctx.t("use")}
									</button>
								</Show>
								<button
									onClick={() =>
										void run(() =>
											rpc().remove({
												alias: account.alias,
												providerID: account.providerID,
											}),
										)
									}
								>
									{ctx.t("remove")}
								</button>
							</div>
						)}
					</For>

					<div style={{ ...row, "margin-top": "4px" }}>
						<input
							onInput={(event) => setProvider(event.currentTarget.value)}
							placeholder={ctx.t("provider")}
							style={field}
							value={provider()}
						/>
						<input
							onInput={(event) => setAlias(event.currentTarget.value)}
							placeholder={ctx.t("alias")}
							style={field}
							value={alias()}
						/>
						<button
							onClick={() =>
								void run(() =>
									rpc().add({ alias: alias(), providerID: provider() }),
								)
							}
						>
							{ctx.t("add")}
						</button>
					</div>

					<div style={{ ...row, "margin-top": "4px" }}>
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
					</div>

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

					<For each={visibleChains()}>
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
										title={isCollapsed(chain.key) ? "expand" : "collapse"}
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
												void run(() => rpc().chainReset({ key: chain.key }))
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
													{index() + 1}. {target.providerID} · {target.modelID}
													<Show when={target.state === "in use"}>
														<span style={{ opacity: 0.6 }}> · in use</span>
													</Show>
													<Show
														when={
															target.state !== "in use" &&
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
													disabled={index() === chain.targets.length - 1}
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
										{ctx.t("window")} {size(chain.context)} ·{" "}
										{ctx.t("declares")} {size(chain.declaredContext)}
									</div>

									<Show
										fallback={
											<button onClick={() => void startAdd(chain.key)}>
												+ {ctx.t("addTarget")}
											</button>
										}
										when={adding() === chain.key}
									>
										<div style={row}>
											<select
												onChange={(event) =>
													void chooseProvider(event.currentTarget.value)
												}
												style={field}
												value={addProvider()}
											>
												<option value="">provider</option>
												<For
													each={providers().filter(
														(entry) =>
															!chain.targets.some(
																(target) =>
																	target.providerID === entry.providerID,
															),
													)}
												>
													{(entry) => (
														<option value={entry.providerID}>
															{entry.name}
														</option>
													)}
												</For>
											</select>
											<select
												onChange={(event) =>
													void run(() =>
														rpc().chainAdd({
															key: chain.key,
															modelID: event.currentTarget.value,
															providerID: addProvider(),
														}),
													).then(() => setAdding(""))
												}
												style={field}
												value=""
											>
												<option value="">model</option>
												<For each={addModels()}>
													{(model) => (
														<option value={model.modelID}>{model.name}</option>
													)}
												</For>
											</select>
											<button onClick={() => setAdding("")}>cancel</button>
										</div>
									</Show>
								</Show>
							</div>
						)}
					</For>

					<Show when={providers().length > 0}>
						<div style={{ ...row, "margin-top": "4px" }}>
							<strong>{ctx.t("providers")}</strong>
						</div>
						<For each={providers()}>
							{(entry, index) => (
								<div style={row}>
									<input
										checked={entry.enabled}
										onChange={(event) =>
											void run(() =>
												rpc().setEnabled({
													enabled: event.currentTarget.checked,
													providerID: entry.providerID,
												}),
											)
										}
										type="checkbox"
									/>
									<span
										style={{
											flex: "1 1 140px",
											"min-width": 0,
											"overflow-wrap": "anywhere",
										}}
									>
										{entry.name}
									</span>
									<label
										style={{ display: "flex", gap: "4px" }}
										title="use only this provider's free models"
									>
										<input
											checked={entry.freeOnly}
											onChange={(event) =>
												void run(() =>
													rpc().setFreeOnly({
														enabled: event.currentTarget.checked,
														providerID: entry.providerID,
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
													direction: "up",
													providerID: entry.providerID,
												}),
											)
										}
									>
										↑
									</button>
									<button
										disabled={index() === providers().length - 1}
										onClick={() =>
											void run(() =>
												rpc().move({
													direction: "down",
													providerID: entry.providerID,
												}),
											)
										}
									>
										↓
									</button>
								</div>
							)}
						</For>
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
