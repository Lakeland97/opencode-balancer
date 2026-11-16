import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { copy } from "../copy";
import { Balancer } from "../rpc";
import type {
	Account,
	BufferState,
	Chain,
	Chains,
	ContextState,
	Listed,
	LogEntry,
	Provider,
	Providers,
	RebalanceState,
	Reply,
	Status,
} from "../types";
import {
	beginGrab,
	clampCursor,
	endGrab,
	type Grab,
	grabMove,
	moveCursor,
	pageCursor,
} from "./items";

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
 * One focusable control, in render order. A grip item carries the grab it
 * starts and the callback that performs the matching RPC when it moves.
 */
type Item = {
	label: string;
	activate?: () => void;
	grab?: Grab;
	moveGrab?: (delta: number) => void;
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
	const [accounts, setAccounts] = createSignal<Account[]>([]);
	const [chains, setChains] = createSignal<Chain[]>([]);
	const [priority, setPriority] = createSignal<Provider[]>([]);
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
			setLog([...(nextLog as { entries: LogEntry[] }).entries]);
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

	// The thin slice's one control. Later sections append in render order.
	const items = createMemo<Item[]>(() => [
		{
			activate: () =>
				void run(() => client.setBalancing({ enabled: !status()?.balancing })),
			label: `${copy.balancing}: ${status()?.balancing ? "on" : "off"}`,
		},
	]);
	const [cursor, setCursor] = createSignal<{ index: number; grab?: Grab }>({
		index: 0,
	});
	// The scrollbox may come from a different OpenTUI install than the one this
	// module resolves, so hold only the surface used here.
	let container:
		| {
				focus(): void;
				scrollChildIntoView?(id: string): void;
				scrollTo(position: number): void;
		  }
		| undefined;

	const pageSize = () => Math.max(1, props.ctx.renderer.height - 6);
	const setIndex = (index: number) =>
		setCursor((current) => ({ ...current, index }));

	// A list that grows or shrinks under the cursor must not leave it pointing
	// past the end.
	createEffect(() => {
		const count = items().length;
		setCursor((current) =>
			current.index < count
				? current
				: { ...current, index: clampCursor(current.index, count) },
		);
	});

	// Keep the focused row visible. The scrollbox can bring a child into view by
	// id; older renderers fall back to centring the index in the viewport.
	createEffect(() => {
		const index = cursor().index;
		queueMicrotask(() => {
			if (!container) return;
			if (typeof container.scrollChildIntoView === "function") {
				container.scrollChildIntoView(`balancer-item-${index}`);
				return;
			}
			container.scrollTo(Math.max(0, index - Math.floor(pageSize() / 2)));
		});
	});

	const move = (delta: number) =>
		setCursor((current) => ({
			...current,
			index: moveCursor(current.index, delta, items().length),
		}));

	const moveGrab = (delta: number) => {
		const current = cursor();
		const item = items()[current.index];
		const next = grabMove(current, delta, items().length);
		if (next === undefined || !item?.moveGrab) return;
		setIndex(next);
		item.moveGrab(delta);
	};

	useKeyboard((key) => {
		const name = key.name;
		const grabbing = cursor().grab;
		if (grabbing) {
			// While a grip is held, the arrows move the row itself; everything
			// else is ignored so a stray key cannot drop it.
			if (name === "up" || name === "k") return moveGrab(-1);
			if (name === "down" || name === "j") return moveGrab(1);
			if (
				name === "return" ||
				name === "enter" ||
				name === "escape" ||
				name === "left" ||
				name === "right"
			) {
				return setCursor(endGrab);
			}
			return;
		}
		if (name === "up" || name === "k") return move(-1);
		if (name === "down" || name === "j") return move(1);
		if (name === "pageup") {
			return setCursor((current) => ({
				...current,
				index: pageCursor(current.index, -1, items().length, pageSize()),
			}));
		}
		if (name === "pagedown") {
			return setCursor((current) => ({
				...current,
				index: pageCursor(current.index, 1, items().length, pageSize()),
			}));
		}
		if (name === "home") return setIndex(0);
		if (name === "end") return setIndex(Math.max(0, items().length - 1));
		if (name === "tab") return move(key.shift ? -1 : 1);
		if (name === "return" || name === "enter" || name === "space") {
			const item = items()[cursor().index];
			if (!item) return;
			if (item.grab) return setCursor(beginGrab(cursor().index, item.grab));
			item.activate?.();
			return;
		}
		if (name === "escape") return setCursor(endGrab);
		if (name === "r") return void refresh();
		if (name === "f") return props.panel.toggleFullscreen();
		if (name === "q") return props.panel.close();
	});

	onMount(() => {
		container?.focus();
		void refresh();
		const timer = setInterval(() => void refresh(), 2000);
		onCleanup(() => clearInterval(timer));
	});

	return (
		<scrollbox
			focusable
			focused={props.panel.focused}
			ref={(element) => {
				container = element;
			}}
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
			<For each={items()}>
				{(item, index) => (
					<box id={`balancer-item-${index()}`}>
						<text>
							{`${index() === cursor().index ? "›" : " "} ${item.label}`}
						</text>
					</box>
				)}
			</For>
		</scrollbox>
	);
}
