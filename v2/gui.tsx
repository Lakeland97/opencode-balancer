/** @jsxImportSource solid-js */

import { Command, Panel, type PanelTab, Plugin } from "@opencode/plugin/gui";
import { createSignal, For, onMount, Show } from "solid-js";
import { Balancer } from "./rpc";

type Account = {
	providerID: string;
	alias: string;
	active: boolean;
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
			add: "add",
			alias: "alias",
			balancing: "balancing",
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
				setMessage(reply.message);
				await refresh();
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
			}
		};

		const rpc = () => ctx.client.rpc(Balancer);

		const row = {
			"align-items": "center",
			display: "flex",
			gap: "6px",
		} as const;

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
								<span style={{ flex: 1 }}>
									{account.providerID}/{account.alias}
									{account.active ? " · active" : ""}
									{account.limited ? " · limited" : ""}
									{account.disabled ? " · disabled" : ""}
								</span>
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
							style={{ flex: 1 }}
							value={provider()}
						/>
						<input
							onInput={(event) => setAlias(event.currentTarget.value)}
							placeholder={ctx.t("alias")}
							style={{ flex: 1 }}
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
			closable: "compact",
			fallback: true,
			id: "accounts",
			get title() {
				return ctx.t("title");
			},
		};

		ctx.add(Panel, {
			id: "accounts",
			list: (input) => (input.open.includes("accounts") ? [tab] : []),
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

		ctx.add(Command, () => ({
			id: "open",
			run: () => {
				const session = ctx.sessions.current();
				if (session) ctx.layout.open(`${ctx.id}:accounts`, session);
			},
			title: ctx.t("open"),
		}));
	},
});
