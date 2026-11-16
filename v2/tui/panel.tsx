import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { copy } from "../copy";
import { Balancer } from "../rpc";

/** The answer every write gives, until `v2/types.ts` owns the view types. */
type Reply = { ok: boolean; message: string };

type Status = {
	accounts: number;
	balancing: boolean;
	limited: number;
	providers: number;
};
type Listed = { accounts: unknown[] };
type Chains = { rows: unknown[] };
type Providers = { entries: unknown[] };
type ContextState = { value: string };
type BufferState = { enforce: string; value: string };
type RebalanceState = { auto: boolean; value: string };
type LogEntry = { at: number; kind: string; text: string };
type Log = { entries: LogEntry[] };

/** The session-panel input the host passes to a contribution. */
export type PanelInput = {
	readonly name: string;
	readonly sessionID: string;
	readonly width: number;
	readonly presentation: "panel" | "fullscreen";
	readonly focused: boolean;
	readonly focus: () => void;
	readonly close: () => void;
	readonly toggleFullscreen: () => void;
};

/**
 * The whole panel state in one poll. The thin slice renders the title and the
 * balancing switch; later sections read the same signals.
 */
export function BalancerPanel(props: {
	ctx: Plugin.Context;
	panel: PanelInput;
}) {
	const client = props.ctx.client.rpc(Balancer);
	const [status, setStatus] = createSignal<Status>();
	const [accounts, setAccounts] = createSignal<unknown[]>([]);
	const [chains, setChains] = createSignal<unknown[]>([]);
	const [priority, setPriority] = createSignal<unknown[]>([]);
	const [contextLimit, setContextLimit] = createSignal<ContextState>({
		value: "",
	});
	const [contextBuffer, setContextBuffer] = createSignal<BufferState>({
		enforce: "always",
		value: "",
	});
	const [rebalance, setRebalance] = createSignal<RebalanceState>({
		auto: false,
		value: "",
	});
	const [log, setLog] = createSignal<LogEntry[]>([]);
	const [message, setMessage] = createSignal("");

	/**
	 * Read everything at once. A failed poll keeps the last good state: the
	 * panel going blank because one request dropped is worse than a stale row.
	 */
	const refresh = async () => {
		try {
			const [nextStatus, list, nextChains, nextPriority] = await Promise.all([
				client.status({}),
				client.list({}),
				client.chains({}),
				client.priority({}),
			]);
			const [limit, buffer, after, nextLog] = await Promise.all([
				client.contextLimit({}),
				client.contextBuffer({}),
				client.rebalance({}),
				client.log({}),
			]);
			setStatus(nextStatus as Status);
			setAccounts([...(list as Listed).accounts]);
			setChains([...(nextChains as Chains).rows]);
			setPriority([...(nextPriority as Providers).entries]);
			setContextLimit(limit as ContextState);
			setContextBuffer(buffer as BufferState);
			setRebalance(after as RebalanceState);
			setLog([...(nextLog as Log).entries]);
		} catch {
			// Keep the last good state.
		}
	};

	const run = async (action: () => Promise<unknown>) => {
		try {
			const reply = (await action()) as Reply;
			setMessage(reply.ok ? "" : reply.message);
			await refresh();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};

	const edit = async (
		title: string,
		value: string,
		apply: (value: string) => Promise<unknown>,
	) => {
		const next = await props.ctx.ui.dialog.prompt({ title, value });
		if (next === undefined || next === value) return;
		await run(() => apply(next));
	};

	const pick = <T extends string>(
		title: string,
		options: readonly { title: string; value: T }[],
	) => props.ctx.ui.dialog.select<T>({ options, title });

	useKeyboard((key) => {
		if (key.name === "f") props.panel.toggleFullscreen();
		if (key.name === "q") props.panel.close();
	});

	onMount(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 2000);
		onCleanup(() => clearInterval(timer));
	});

	return (
		<scrollbox
			focused={props.panel.focused}
			style={{
				flexDirection: "column",
				flexGrow: 1,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text>
				{`${copy.title}  ${status()?.balancing ? copy.balancing : "off"}`}
			</text>
			<Show when={message()}>
				{(text) => <text style={{ fg: "red" }}>{text()}</text>}
			</Show>
		</scrollbox>
	);
}
