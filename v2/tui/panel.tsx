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
import { bufferTokens, cutFor, formatTokens } from "../core/context";
import { formatAttempt, routeMarkers } from "../core/format";
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
import { providerEntries, rowNote } from "./rows";

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
	id: string;
	activate?: () => void;
	grab?: Grab;
	moveGrab?: (delta: number) => void;
	/** The row a grip belongs to, so focus can find it again after a reorder. */
	rowKey?: string;
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
	const [openNote, setOpenNote] = createSignal("");

	const providerKey = (providerID: string, alias: string) =>
		`${providerID}/${alias}`;

	const moveProvider = async (
		providerID: string,
		alias: string,
		delta: -1 | 1,
	) => {
		const rows = providerEntries(accounts(), priority());
		const from = rows.findIndex(
			(row) => row.entry.providerID === providerID && row.entry.alias === alias,
		);
		if (from === -1) return;
		// The reducer only bounds-checks here: the RPC moves the row itself, and
		// focus is put back on its grip after the reorder lands.
		const next = grabMove(
			beginGrab(from, { kind: "provider" }),
			delta,
			rows.length,
		);
		if (next === undefined) return;
		const result = (await client.move({
			alias,
			direction: delta < 0 ? "up" : "down",
			providerID,
		})) as Reply;
		setMessage(result.ok ? "" : result.message);
		await refresh();
		const key = providerKey(providerID, alias);
		const grip = items().findIndex(
			(item) => item.rowKey === key && item.grab?.kind === "provider",
		);
		if (grip >= 0) setIndex(grip);
	};

	const toggleNote = (key: string) =>
		setOpenNote((current) => (current === key ? "" : key));

	const editEnforcement = async () => {
		const value = await pick<"always" | "necessary">(copy.enforce, [
			{ title: copy.always, value: "always" },
			{ title: copy.necessary, value: "necessary" },
		]);
		if (value === undefined || value === contextBuffer().enforce) return;
		await run(() => client.setBufferEnforce({ value }));
	};

	const items = createMemo<Item[]>(() => {
		const list: Item[] = [
			{
				activate: () =>
					void run(() =>
						client.setBalancing({ enabled: !status()?.balancing }),
					),
				id: "balancing",
			},
			{
				activate: () =>
					void run(() =>
						client.setRebalanceAuto({ enabled: !rebalance().auto }),
					),
				id: "rebalance-auto",
			},
			{
				activate: () =>
					void edit(copy.rebalance, rebalance().value, (value) =>
						client.setRebalance({ value }),
					),
				id: "rebalance-length",
			},
			{
				activate: () =>
					void edit(copy.contextLimit, contextLimit().value, (value) =>
						client.setContextLimit({ value }),
					),
				id: "limit",
			},
			{
				activate: () =>
					void edit(copy.buffer, contextBuffer().value, (value) =>
						client.setContextBuffer({ value }),
					),
				id: "buffer",
			},
			{
				activate: () => void editEnforcement(),
				id: "enforce",
			},
		];
		for (const row of providerEntries(accounts(), priority())) {
			const { entry, account } = row;
			const key = providerKey(entry.providerID, entry.alias);
			list.push({
				activate: () =>
					void run(() =>
						client.setEnabled({
							alias: entry.alias,
							enabled: !entry.enabled,
							providerID: entry.providerID,
						}),
					),
				id: `${key}:enable`,
			});
			if (rowNote(account, copy.resets)) {
				list.push({
					activate: () => toggleNote(key),
					id: `${key}:note`,
				});
			}
			list.push({
				activate: () =>
					void run(() =>
						client.setFreeOnly({
							alias: entry.alias,
							enabled: !entry.freeOnly,
							providerID: entry.providerID,
						}),
					),
				id: `${key}:free`,
			});
			list.push({
				activate: () =>
					void run(() =>
						client.use({
							alias: entry.alias,
							providerID: entry.providerID,
						}),
					),
				id: `${key}:use`,
			});
			list.push({
				grab: { kind: "provider" },
				id: `${key}:grip`,
				moveGrab: (delta) =>
					void moveProvider(entry.providerID, entry.alias, delta < 0 ? -1 : 1),
				rowKey: key,
			});
		}
		return list;
	});
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
		const item = items()[cursor().index];
		item?.moveGrab?.(delta);
	};

	const releaseGrab = () => {
		setCursor(endGrab);
		// Polling paused while the row was held; read the world once more now
		// that it can move under the cursor again.
		void refresh();
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
				return releaseGrab();
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
		const timer = setInterval(() => {
			// A held row owns the screen: the list must not shift under it.
			if (!cursor().grab) void refresh();
		}, 2000);
		onCleanup(() => clearInterval(timer));
	});

	const itemIndex = (id: string) => items().findIndex((item) => item.id === id);
	const itemID = (id: string) => `balancer-item-${itemIndex(id)}`;
	const focused = (id: string) => itemIndex(id) === cursor().index;
	const mark = (id: string) => (focused(id) ? "›" : " ");
	const cut = () =>
		cutFor(
			contextLimit().value,
			contextBuffer().value,
			contextBuffer().enforce,
		);

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
			<box id={itemID("balancing")}>
				<text>{`${mark("balancing")} ${copy.balancing}: ${
					status()?.balancing ? "on" : "off"
				}`}</text>
			</box>
			<box id={itemID("rebalance-auto")}>
				<text>{`${mark("rebalance-auto")} [${rebalance().auto ? "x" : " "}] ${
					copy.rebalance
				}`}</text>
			</box>
			<box id={itemID("rebalance-length")}>
				<text>{`${mark("rebalance-length")} ${copy.rebalance}: ${
					rebalance().value || "built-in"
				}`}</text>
			</box>
			<box id={itemID("limit")}>
				<text>{`${mark("limit")} ${copy.contextLimit}: ${
					contextLimit().value || "default"
				}  at ${formatTokens(cut()) || "—"}`}</text>
			</box>
			<box id={itemID("buffer")}>
				<text>{`${mark("buffer")} ${copy.buffer}: ${
					contextBuffer().value || "built-in"
				}${
					bufferTokens(contextBuffer().value) > 0
						? ` (${formatTokens(bufferTokens(contextBuffer().value))})`
						: ""
				}`}</text>
			</box>
			<box id={itemID("enforce")}>
				<text>{`${mark("enforce")} ${copy.enforce}: ${
					contextBuffer().enforce
				}`}</text>
			</box>
			<Show when={message()}>
				{(text) => <text style={{ fg: "red" }}>{text()}</text>}
			</Show>
			<text>{copy.providers}</text>
			<For each={providerEntries(accounts(), priority())}>
				{(row) => {
					const key = providerKey(row.entry.providerID, row.entry.alias);
					const note = () => rowNote(row.account, copy.resets);
					const markers = () =>
						row.account
							? routeMarkers({
									active: row.account.active,
									inUse: row.account.inUse,
									limited: row.account.limited,
								})
									.map((marker) => ` · ${copy[marker]}`)
									.join("")
							: "";
					const moving = () =>
						Boolean(cursor().grab) && items()[cursor().index]?.rowKey === key;
					return (
						<box style={{ flexDirection: "column", marginBottom: 1 }}>
							<box id={itemID(`${key}:enable`)}>
								<text>{`${mark(`${key}:enable`)} [${
									row.entry.enabled ? "x" : " "
								}] ${row.entry.name} / ${row.entry.alias}${markers()}${
									moving() ? "  moving" : ""
								}`}</text>
							</box>
							<Show when={note()}>
								{(value) => (
									<>
										<box id={itemID(`${key}:note`)}>
											<text>{`${mark(`${key}:note`)}   ${value()}`}</text>
										</box>
										<Show when={openNote() === key}>
											<text>{`      last tried ${formatAttempt(
												row.account?.lastUsedAt,
											)}`}</text>
										</Show>
									</>
								)}
							</Show>
							<box style={{ flexDirection: "row", gap: 2 }}>
								<box id={itemID(`${key}:free`)}>
									<text>{`${mark(`${key}:free`)}[${
										row.entry.freeOnly ? "x" : " "
									}] ${copy.free}`}</text>
								</box>
								<box id={itemID(`${key}:use`)}>
									<text>{`${mark(`${key}:use`)}[${copy.use}]`}</text>
								</box>
								<box id={itemID(`${key}:grip`)}>
									<text>{`${mark(`${key}:grip`)}⠿`}</text>
								</box>
							</box>
						</box>
					);
				}}
			</For>
		</scrollbox>
	);
}
