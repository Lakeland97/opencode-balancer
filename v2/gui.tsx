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

export default Plugin.define({
	i18n: {
		en: {
			active: "active",
			add: "add",
			alias: "alias",
			balancing: "balancing",
			disabled: "disabled",
			inUse: "in use",
			limited: "limited",
			open: "Open Balancer",
			provider: "provider",
			refresh: "refresh",
			remove: "remove",
			title: "Balancer",
			use: "use",
		},
	},
	setup(ctx) {
		const [accounts, setAccounts] = createSignal<Account[]>([]);
		const [balancing, setBalancing] = createSignal(false);
		const [message, setMessage] = createSignal("");
		const [provider, setProvider] = createSignal("");
		const [alias, setAlias] = createSignal("");

		const refresh = async () => {
			try {
				const rpc = ctx.client.rpc(Balancer);
				const [status, list] = await Promise.all([
					rpc.status({}),
					rpc.list({}),
				]);
				setBalancing((status as Status).balancing);
				setAccounts([...(list as Listed).accounts]);
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
			}
		};

		const run = async (action: () => Promise<unknown>) => {
			try {
				const reply = (await action()) as Reply;
				// The rows already show the result; only failures need words.
				setMessage(reply.ok ? "" : reply.message);
				await refresh();
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
			}
		};

		const rpc = () => ctx.client.rpc(Balancer);

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
