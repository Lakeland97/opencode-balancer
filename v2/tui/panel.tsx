import type { Plugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import { copy } from "../copy";
import { mergeChainGroups, mergeChainRows } from "../core/chain-view";
import { bufferTokens, cutFor, formatTokens } from "../core/context";
import { formatAttempt, routeMarkers } from "../core/format";
import { Balancer } from "../rpc";
import type {
	Account,
	BufferState,
	Chain,
	Chains,
	ContextState,
	InUse,
	InUseEntry,
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
	panelOwnsKey,
} from "./items";
import {
	allCollapsed,
	groupedChains,
	providerEntries,
	rowNote,
	servingLine,
	visibleChains,
} from "./rows";

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
		nextAt: 0,
		value: "",
	});
	const [log, setLog] = createSignal<LogEntry[]>([]);
	// What is being served right now, one entry per row. More than one is
	// normal: a row split across providers, or two conversations on different
	// models, both show rather than as a single "in use".
	const [inUse, setInUse] = createSignal<InUseEntry[]>([]);
	const [message, setMessage] = createSignal("");
	const [dialogOpen, setDialogOpen] = createSignal(false);
	// Every read gets a generation; only the newest may apply its result.
	let refreshGeneration = 0;

	/**
	 * Read everything at once. A failed poll keeps the last good state: the
	 * panel going blank because one request dropped is worse than a stale row.
	 * A slower, older read never overwrites a newer one.
	 */
	const refresh = async () => {
		const generation = ++refreshGeneration;
		try {
			const [nextStatus, list, nextChains, nextPriority, serving] =
				await Promise.all([
					client.status({}),
					client.list({}),
					client.chains({}),
					client.priority({}),
					client.inUse({}),
				]);
			const [limit, buffer, after, nextLog] = await Promise.all([
				client.contextLimit({}),
				client.contextBuffer({}),
				client.rebalance({}),
				client.log({}),
			]);
			if (generation !== refreshGeneration) return;
			setStatus(nextStatus as Status);
			setAccounts([...(list as Listed).accounts]);
			// A poll that learned nothing must not rebuild a row: the add form and
			// the pickers live inside rows.
			setChains(mergeChainRows(chains(), [...(nextChains as Chains).rows]));
			setPriority([...(nextPriority as Providers).entries]);
			setInUse([...(serving as InUse).entries]);
			setContextLimit(limit as ContextState);
			setContextBuffer(buffer as BufferState);
			setRebalance(after as RebalanceState);
			setLog([...(nextLog as { entries: LogEntry[] }).entries]);
			setLastRefreshed(Date.now());
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
			setMessage(describe(error));
		}
	};

	const withDialog = async <T,>(show: () => Promise<T>) => {
		setDialogOpen(true);
		try {
			return await show();
		} finally {
			setDialogOpen(false);
		}
	};

	const edit = async (
		title: string,
		value: string,
		apply: (value: string) => Promise<unknown>,
	) => {
		const next = await withDialog(() =>
			props.ctx.ui.dialog.prompt({ title, value }),
		);
		if (next === undefined || next === value) return;
		await run(() => apply(next));
	};

	const pick = <T extends string>(
		title: string,
		options: readonly { title: string; value: T }[],
	) => withDialog(() => props.ctx.ui.dialog.select<T>({ options, title }));

	// The thin slice's one control. Later sections append in render order.
	const [openNote, setOpenNote] = createSignal("");
	const [modelsOpen, setModelsOpen] = createSignal(false);
	const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
	const [collapsedGroups, setCollapsedGroups] = createSignal<
		Record<string, boolean>
	>({});
	const [creating, setCreating] = createSignal(false);
	const [diagOpen, setDiagOpen] = createSignal(false);
	const [lastRefreshed, setLastRefreshed] = createSignal(0);

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
		let result: Reply;
		try {
			result = (await client.move({
				alias,
				direction: delta < 0 ? "up" : "down",
				providerID,
			})) as Reply;
		} catch (error) {
			// The grab stays held: the row did not move, and the user can retry
			// or release it.
			setMessage(describe(error));
			await refresh();
			return;
		}
		setMessage(result.ok ? "" : result.message);
		await refresh();
		const key = providerKey(providerID, alias);
		const grip = items().findIndex(
			(item) => item.rowKey === key && item.grab?.kind === "provider",
		);
		if (grip >= 0) focusAt(grip);
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

	const sortModels = (models: { modelID: string; name: string }[]) =>
		models
			.slice()
			.sort((a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
			);

	const isChainCollapsed = (key: string) => collapsed()[key] !== false;
	const toggleChain = (key: string) =>
		setCollapsed((current) => ({
			...current,
			[key]: !isChainCollapsed(key),
		}));
	const isGroupCollapsed = (brand: string) =>
		collapsedGroups()[brand] !== false;
	const toggleGroup = (brand: string) =>
		setCollapsedGroups((current) => ({
			...current,
			[brand]: !isGroupCollapsed(brand),
		}));

	const foldModels = (open: boolean) => {
		setModelsOpen(open);
		// Folding the section also drops a chain draft, exactly as its own fold
		// control does.
		if (!open) setCreating(false);
	};

	// Rows gather under the brand their label starts with. Brand headers are new
	// objects on every read, so the previous ones are handed back when nothing
	// moved: the rows inside them keep their identity, and a focused control in
	// one of them is not rebuilt by a poll.
	let lastGroups: ReturnType<typeof groupedChains> = [];
	const groups = createMemo(() => {
		lastGroups = mergeChainGroups(lastGroups, groupedChains(chains()));
		return lastGroups;
	});

	const everythingCollapsed = () =>
		allCollapsed({
			chains: chains(),
			collapsed: collapsed(),
			groups: collapsedGroups(),
			modelsOpen: modelsOpen(),
		});

	const toggleAllChains = () => {
		if (everythingCollapsed()) {
			setCollapsed({});
			setCollapsedGroups({});
			setModelsOpen(true);
			return;
		}
		const rows: Record<string, boolean> = {};
		for (const chain of visibleChains(chains())) rows[chain.key] = true;
		const collapsedByBrand: Record<string, boolean> = {};
		for (const group of groups()) {
			if (group.brand) collapsedByBrand[group.brand] = true;
		}
		setCollapsed(rows);
		setCollapsedGroups(collapsedByBrand);
		setModelsOpen(false);
		setCreating(false);
	};

	const providerChoices = () => {
		const names = new Map<string, string>();
		for (const entry of priority()) {
			if (!names.has(entry.providerID)) names.set(entry.providerID, entry.name);
		}
		return [...names.entries()].map(([value, title]) => ({ title, value }));
	};

	const chooseModel = async (providerID: string, wire?: string) => {
		let data: { models: { modelID: string; name: string }[] };
		try {
			data = (await client.chainModels({ package: wire, providerID })) as {
				models: { modelID: string; name: string }[];
			};
		} catch (error) {
			setMessage(describe(error));
			return undefined;
		}
		return pick(
			copy.models,
			sortModels(data.models).map((model) => ({
				title: model.name,
				value: model.modelID,
			})),
		);
	};

	const startCreate = async () => {
		if (creating()) {
			setCreating(false);
			return;
		}
		setModelsOpen(true);
		setCreating(true);
		const choices = providerChoices();
		if (choices.length === 0) {
			setCreating(false);
			setMessage("No providers saved.");
			return;
		}
		const providerID = await pick(copy.provider, choices);
		if (providerID === undefined) {
			setCreating(false);
			return;
		}
		const modelID = await chooseModel(providerID);
		if (modelID === undefined) {
			setCreating(false);
			return;
		}
		await run(() => client.chainCreate({ modelID, providerID }));
		setCreating(false);
	};

	const startAdd = async (chain: Chain) => {
		setModelsOpen(true);
		const used = new Set(chain.targets.map((target) => target.providerID));
		const choices = providerChoices().filter(
			(choice) => !used.has(choice.value),
		);
		if (choices.length === 0) {
			setMessage(copy.everyProviderUsed);
			return;
		}
		const providerID = await pick(copy.provider, choices);
		if (providerID === undefined) return;
		const modelID = await chooseModel(providerID, chain.package);
		if (modelID === undefined) return;
		await run(() => client.chainAdd({ key: chain.key, modelID, providerID }));
		setCollapsed((current) => ({ ...current, [chain.key]: false }));
	};

	const editLimit = async (chain: Chain) => {
		await edit(copy.limit, chain.limit, (value) =>
			client.setModelLimit({ key: chain.key, value }),
		);
	};

	const moveTarget = async (
		chain: Chain,
		providerID: string,
		delta: -1 | 1,
	) => {
		const from = chain.targets.findIndex(
			(target) => target.providerID === providerID,
		);
		if (from === -1) return;
		const next = grabMove(
			beginGrab(from, { key: chain.key, kind: "target" }),
			delta,
			chain.targets.length,
		);
		if (next === undefined) return;
		let result: Reply;
		try {
			result = (await client.chainMove({
				direction: delta < 0 ? "up" : "down",
				key: chain.key,
				providerID,
			})) as Reply;
		} catch (error) {
			setMessage(describe(error));
			await refresh();
			return;
		}
		setMessage(result.ok ? "" : result.message);
		await refresh();
		const rowKey = `${chain.key}:${providerID}`;
		const grip = items().findIndex(
			(item) => item.rowKey === rowKey && item.grab?.kind === "target",
		);
		if (grip >= 0) focusAt(grip);
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
		list.push({
			activate: () => foldModels(!modelsOpen()),
			id: "models:fold",
		});
		list.push({
			activate: () => void startCreate(),
			id: "models:new",
		});
		list.push({
			activate: toggleAllChains,
			id: "models:all",
		});
		if (modelsOpen()) {
			for (const group of groups()) {
				if (group.brand) {
					list.push({
						activate: () => toggleGroup(group.brand ?? ""),
						id: `g:${group.brand}:fold`,
					});
					if (isGroupCollapsed(group.brand)) continue;
				}
				for (const chain of group.rows) {
					list.push({
						activate: () => toggleChain(chain.key),
						id: `c:${chain.key}:fold`,
					});
					list.push({
						activate: () => void editLimit(chain),
						id: `c:${chain.key}:limit`,
					});
					if (chain.stored) {
						list.push({
							activate: () =>
								void run(() => client.chainReset({ key: chain.key })),
							id: `c:${chain.key}:reset`,
						});
					}
					if (isChainCollapsed(chain.key)) continue;
					for (const target of chain.targets) {
						const rowKey = `${chain.key}:${target.providerID}`;
						list.push({
							grab: { key: chain.key, kind: "target" },
							id: `${rowKey}:grip`,
							moveGrab: (delta) =>
								void moveTarget(chain, target.providerID, delta < 0 ? -1 : 1),
							rowKey,
						});
						list.push({
							activate: () =>
								void run(() =>
									client.chainRemove({
										key: chain.key,
										providerID: target.providerID,
									}),
								),
							id: `${rowKey}:remove`,
						});
					}
					list.push({
						activate: () => void startAdd(chain),
						id: `c:${chain.key}:add`,
					});
				}
			}
		}
		list.push({
			activate: () => setDiagOpen(!diagOpen()),
			id: "diag:fold",
		});
		list.push({
			activate: () => void refresh(),
			id: "diag:refresh",
		});
		if (diagOpen() && log().length > 0) {
			list.push({
				activate: () => void run(() => client.clearLog({})),
				id: "diag:clear",
			});
		}
		return list;
	});
	const [cursor, setCursor] = createSignal<{
		grab?: Grab;
		id?: string;
		index: number;
	}>({
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

	/** Move focus to an index and remember which item it landed on. */
	const focusAt = (index: number) =>
		setCursor((current) => {
			const next = clampCursor(index, items().length);
			return { ...current, id: items()[next]?.id, index: next };
		});

	// A list that grows, shrinks or reorders under the cursor must keep focus on
	// the same control, not the same number. When that control disappears (a row
	// reset, a removed target, a cleared log), the nearest slot takes over.
	createEffect(
		on(items, (list) => {
			const current = untrack(cursor);
			if (current.id) {
				const found = list.findIndex((item) => item.id === current.id);
				if (found !== -1) {
					if (found !== current.index) {
						setCursor((value) => ({ ...value, index: found }));
					}
					return;
				}
			}
			const index = clampCursor(current.index, list.length);
			const id = list[index]?.id;
			if (index !== current.index || id !== current.id) {
				setCursor((value) => ({ ...value, id, index }));
			}
		}),
	);

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
		focusAt(moveCursor(cursor().index, delta, items().length));

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
		// The composer and dialogs own the keyboard when the panel is not the
		// focused surface. Without this guard, typing a space in a session would
		// toggle whatever control the hidden cursor happened to be on.
		if (
			!panelOwnsKey({
				ctrl: key.ctrl,
				dialogOpen: dialogOpen(),
				focused: props.panel.focused,
				meta: key.meta,
				option: key.option,
				super: key.super,
			})
		) {
			return;
		}
		const name = key.name;
		key.preventDefault();
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
			return focusAt(
				pageCursor(cursor().index, -1, items().length, pageSize()),
			);
		}
		if (name === "pagedown") {
			return focusAt(pageCursor(cursor().index, 1, items().length, pageSize()));
		}
		if (name === "home") return focusAt(0);
		if (name === "end") return focusAt(Math.max(0, items().length - 1));
		if (name === "tab") return move(key.shift ? -1 : 1);
		if (name === "return" || name === "enter" || name === "space") {
			const item = items()[cursor().index];
			if (!item) return;
			if (item.grab) {
				// A poll already on the wire must not land mid-grab.
				refreshGeneration += 1;
				setCursor({
					...beginGrab(cursor().index, item.grab),
					id: item.id,
				});
				return;
			}
			item.activate?.();
			return;
		}
		if (name === "escape") return setCursor(endGrab);
		if (name === "r") return void refresh();
		if (name === "f") return props.panel.toggleFullscreen();
		if (name === "q") return props.panel.close();
	});

	onMount(() => {
		props.panel.focus();
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
					rebalance().value || copy.builtIn
				}`}</text>
			</box>
			<box id={itemID("limit")}>
				<text>{`${mark("limit")} ${copy.contextLimit}: ${
					contextLimit().value || copy.defaultValue
				}  ${copy.at} ${formatTokens(cut()) || "—"}`}</text>
			</box>
			<box id={itemID("buffer")}>
				<text>{`${mark("buffer")} ${copy.buffer}: ${
					contextBuffer().value || copy.builtIn
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
			{/*
			 * The one place the panel speaks: an error when there is one,
			 * otherwise the model each row is being served on right now. The
			 * TUI has no hover, so the note that a differing level was asked
			 * for rides dim beside the line instead of in a title.
			 */}
			<Show
				fallback={
					<Show when={inUse().length > 0}>
						<For each={inUse()}>
							{(entry) => {
								const line = () => servingLine(entry);
								return (
									<text attributes={TextAttributes.DIM}>{`${line().text}${
										line().note ? `  ${line().note}` : ""
									}`}</text>
								);
							}}
						</For>
					</Show>
				}
				when={message()}
			>
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
									moving() ? `  ${copy.moving}` : ""
								}`}</text>
							</box>
							<Show when={note()}>
								{(value) => (
									<>
										<box id={itemID(`${key}:note`)}>
											<text>{`${mark(`${key}:note`)}   ${value()}`}</text>
										</box>
										<Show when={openNote() === key}>
											<text>{`      ${copy.lastTried} ${formatAttempt(
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
			<box style={{ flexDirection: "row", gap: 2 }}>
				<box id={itemID("models:fold")}>
					<text>{`${mark("models:fold")} ${
						modelsOpen() ? "▾" : "▸"
					} ${copy.models}`}</text>
				</box>
				<box id={itemID("models:new")}>
					<text>{`${mark("models:new")}[${
						creating() ? copy.cancel : copy.newChain
					}]`}</text>
				</box>
				<box id={itemID("models:all")}>
					<text>{`${mark("models:all")}[${
						everythingCollapsed() ? copy.expand : copy.collapse
					}]`}</text>
				</box>
			</box>
			<Show when={modelsOpen()}>
				<For each={groups()}>
					{(group) => (
						<box style={{ flexDirection: "column" }}>
							<Show when={group.brand}>
								{(brand) => (
									<box id={itemID(`g:${brand()}:fold`)}>
										<text>{`${mark(`g:${brand()}:fold`)} ${
											isGroupCollapsed(brand()) ? "▸" : "▾"
										} ${brand()}  ${group.rows.length}`}</text>
									</box>
								)}
							</Show>
							<Show when={!group.brand || !isGroupCollapsed(group.brand)}>
								<For each={group.rows}>
									{(chain) => (
										<box style={{ flexDirection: "column", marginBottom: 1 }}>
											<box style={{ flexDirection: "row", gap: 2 }}>
												<box id={itemID(`c:${chain.key}:fold`)}>
													<text>{`${mark(`c:${chain.key}:fold`)} ${
														isChainCollapsed(chain.key) ? "▸" : "▾"
													} ${chain.label}`}</text>
												</box>
												<text>{`${chain.targets.length} · ${
													chain.stored ? copy.custom : copy.automatic
												}`}</text>
												<box id={itemID(`c:${chain.key}:limit`)}>
													<text>{`${mark(`c:${chain.key}:limit`)}${copy.limit}: ${
														chain.limit || copy.globalShare
													}`}</text>
												</box>
												<Show when={chain.stored}>
													<box id={itemID(`c:${chain.key}:reset`)}>
														<text>{`${mark(`c:${chain.key}:reset`)}[${
															copy.reset
														}]`}</text>
													</box>
												</Show>
											</box>
											<Show when={!isChainCollapsed(chain.key)}>
												<For each={chain.targets}>
													{(target, index) => {
														const rowKey = `${chain.key}:${target.providerID}`;
														const moving = () =>
															Boolean(cursor().grab) &&
															items()[cursor().index]?.rowKey === rowKey;
														return (
															<box style={{ flexDirection: "row", gap: 2 }}>
																<text>{`   ${index() + 1}. ${
																	target.providerID
																} · ${target.modelID}${
																	target.resolved !== target.modelID
																		? ` → ${target.resolved}`
																		: ""
																}${
																	target.state !== "available"
																		? ` [${target.state}]`
																		: ""
																}${moving() ? `  ${copy.moving}` : ""}`}</text>
																<box id={itemID(`${rowKey}:grip`)}>
																	<text>{`${mark(`${rowKey}:grip`)}⠿`}</text>
																</box>
																<box id={itemID(`${rowKey}:remove`)}>
																	<text>{`${mark(`${rowKey}:remove`)}×`}</text>
																</box>
															</box>
														);
													}}
												</For>
												<box id={itemID(`c:${chain.key}:add`)}>
													<text>{`${mark(
														`c:${chain.key}:add`,
													)}+ ${copy.addTarget}`}</text>
												</box>
											</Show>
										</box>
									)}
								</For>
							</Show>
						</box>
					)}
				</For>
				<Show when={visibleChains(chains()).length === 0}>
					<text>{copy.noChains}</text>
				</Show>
			</Show>
			<box style={{ flexDirection: "row", gap: 2 }}>
				<box id={itemID("diag:fold")}>
					<text>{`${mark("diag:fold")} ${
						diagOpen() ? "▾" : "▸"
					} ${copy.diagnostics}  ${log().length}`}</text>
				</box>
				<box id={itemID("diag:refresh")}>
					<text>{`${mark("diag:refresh")}[${copy.refresh}]`}</text>
				</box>
			</box>
			<Show when={diagOpen()}>
				<text>{`${copy.version} ${props.ctx.app.version}`}</text>
				<text>{`${copy.values} ${
					lastRefreshed()
						? new Date(lastRefreshed()).toLocaleTimeString()
						: copy.notReadYet
				}`}</text>
				<text>{`${accounts().length} credential${
					accounts().length === 1 ? "" : "s"
				} · ${visibleChains(chains()).length} row${
					visibleChains(chains()).length === 1 ? "" : "s"
				} · ${log().length} log line${log().length === 1 ? "" : "s"}`}</text>
				<text>{`${copy.limit} ${
					contextLimit().value || copy.defaultValue
				} · ${copy.cut} ${formatTokens(cut()) || "—"} · ${copy.buffer} ${
					contextBuffer().value || copy.builtIn
				}`}</text>
				<Show when={log().length > 0}>
					<box id={itemID("diag:clear")}>
						<text>{`${mark("diag:clear")}[${copy.clear}]`}</text>
					</box>
					<For each={log()}>
						{(entry) => (
							<text
								attributes={
									entry.kind === "route" ? undefined : TextAttributes.DIM
								}
								wrapMode="word"
							>{`${new Date(entry.at).toTimeString().slice(0, 8)} ${
								entry.text
							}`}</text>
						)}
					</For>
				</Show>
				<Show when={log().length === 0}>
					<text attributes={TextAttributes.DIM}>{copy.logEmpty}</text>
				</Show>
			</Show>
		</scrollbox>
	);
}
