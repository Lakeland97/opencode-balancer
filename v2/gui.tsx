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
import { copy } from "./copy";
import {
	bufferTokens,
	cutFor,
	formatTokens,
	MAX_PERCENT,
} from "./core/context";
import { credentialNote, formatAttempt, routeMarkers } from "./core/format";
import { groupByBrand } from "./core/models";
import { DEFAULT_REBALANCE_MS, formatDuration } from "./core/rebalance";
import { Balancer } from "./rpc";
import type {
	Account,
	BufferState,
	Chain,
	Chains,
	ContextState,
	Listed,
	LogEntry,
	Models,
	Provider,
	Providers,
	RebalanceState,
	Reply,
	Status,
} from "./types";

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
		en: { ...copy },
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
		// How long a session may sit idle before its failover trail is dropped
		// and the order starts again from the head, as typed: `90m`, `5h`.
		// Empty means the built-in window. The toggle above the field says
		// whether the clock runs at all; the field says how long.
		const [rebalance, setRebalance] = createSignal("");
		const [rebalanceAuto, setRebalanceAuto] = createSignal(true);
		const [rebalanceDraft, setRebalanceDraft] = createSignal("");
		const [message, setMessage] = createSignal("");
		const [chains, setChains] = createSignal<Chain[]>([]);
		const [providers, setProviders] = createSignal<Provider[]>([]);
		// The row whose add form is open, plus what the user has picked in it.
		const [adding, setAdding] = createSignal("");
		// Which credential's note is open, as `provider/alias`: one at a time, so
		// the panel cannot fill with expanded messages.
		const [openNote, setOpenNote] = createSignal("");
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
				const [status, list, rows, order, settings, room, idle, log] =
					await Promise.all([
						rpc.status({}),
						rpc.list({}),
						rpc.chains({}),
						rpc.priority({}),
						rpc.contextLimit({}),
						rpc.contextBuffer({}),
						rpc.rebalance({}),
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
				setRebalance((idle as RebalanceState).value);
				setRebalanceAuto((idle as RebalanceState).auto);
				setRebalanceDraft((idle as RebalanceState).value);
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

		const cutTokens = () =>
			cutFor(globalLimitDraft(), bufferDraft(), bufferEnforce());

		const storedCut = () => cutFor(globalLimit(), buffer(), bufferEnforce());

		const commitBuffer = () => {
			if (bufferDraft() === buffer()) return;
			void run(() => rpc().setContextBuffer({ value: bufferDraft() }));
		};

		const commitRebalance = () => {
			if (rebalanceDraft() === rebalance()) return;
			void run(() => rpc().setRebalance({ value: rebalanceDraft() }));
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

		// Dismiss a chain draft. The form lives inside the models section, so
		// both the header button and a fold have to be able to drop it: a
		// half-picked provider that survived a fold would come back on the next
		// open looking like it had been kept on purpose.
		const cancelCreate = () => {
			setCreating(false);
			setCreateProvider("");
			setCreateModels([]);
		};

		const toggleCreate = () => {
			if (creating()) {
				cancelCreate();
				return;
			}
			setCreating(true);
			// The form lives inside the models section. Opening it without
			// opening the section reads as a click that did nothing.
			setModelsOpen(true);
		};

		// Folding the section is also a dismissal: the draft it holds is gone,
		// so reopening starts from an empty form rather than a stale one.
		const toggleModels = () => {
			const open = !modelsOpen();
			setModelsOpen(open);
			if (!open) cancelCreate();
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
		// click away from a single screen of headers. The models section counts
		// as one of those headers: leaving it out made "collapse all" stop one
		// fold short of everything.
		const allCollapsed = () =>
			!modelsOpen() && visibleChains().every((chain) => isCollapsed(chain.key));
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
			// Folding the section also drops a chain draft, exactly as its own
			// fold control does.
			setModelsOpen(!collapse);
			if (collapse) cancelCreate();
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
		// Every button is enclosed, so it reads as something to press rather than as
		// a word that happens to react to a click. The frame is `currentColor`, so it
		// follows the host's theme instead of assuming light or dark.
		const button = {
			background: "none",
			border: "1px solid currentColor",
			"border-radius": "4px",
			color: "inherit",
			cursor: "pointer",
			"font-family": "inherit",
			"font-size": "inherit",
			"line-height": "1.3",
			padding: "0 6px",
		} as const;
		// A select gets the same frame, with its own chevron: the host's native arrow
		// is faint in this panel, and the arrow is the thing that says "a list opens".
		const selectWrap = {
			display: "inline-flex",
			position: "relative",
		} as const;
		const select = {
			appearance: "none",
			background: "none",
			border: "1px solid currentColor",
			"border-radius": "4px",
			color: "inherit",
			cursor: "pointer",
			flex: "1 1 auto",
			"font-family": "inherit",
			"font-size": "inherit",
			"line-height": "1.3",
			"min-width": 0,
			padding: "0 1.5em 0 6px",
		} as const;
		const selectArrow = {
			"font-size": "1.1em",
			"line-height": 1,
			"pointer-events": "none",
			position: "absolute",
			right: "5px",
			top: "50%",
			transform: "translateY(-50%)",
		} as const;
		// A section title is itself a fold control: the little chevron stays for
		// the keyboard, but the word beside it is what a pointer aims at, so the
		// whole header opens the section instead of only the arrow.
		const titleToggle = {
			cursor: "pointer",
			"user-select": "none",
		} as const;
		// A hairline between segments, drawn in the text colour so it follows
		// the theme rather than assuming a light or dark background.
		const divider = {
			"border-top": "1px solid currentColor",
			height: 0,
			opacity: 0.15,
		} as const;

		// Reordering by drag: one grip per row instead of a pair of arrows. The
		// grip is still a control — focus it and the arrow keys move the row — so
		// a keyboard loses nothing by the buttons going away.
		type Drag = { list: string; from: number; to: number };
		const [dragging, setDragging] = createSignal<Drag | null>(null);
		/** The row under the pointer, by the list it belongs to and its slot. */
		const rowUnder = (list: string, x: number, y: number) => {
			for (const element of document.elementsFromPoint(x, y)) {
				const rowElement = element.closest?.("[data-reorder]");
				if (!rowElement || rowElement.getAttribute("data-reorder") !== list) {
					continue;
				}
				const index = Number(rowElement.getAttribute("data-reorder-index"));
				if (Number.isInteger(index)) return index;
			}
			return undefined;
		};
		// A reorderable row keeps a gutter at its right edge, so the grip is in the
		// same place on every row instead of wherever a wrapping label leaves it.
		const grabbableRow = {
			...row,
			"padding-right": "1.4em",
			position: "relative",
		} as const;
		// The grip lives in that gutter rather than in the flow: it cannot be
		// pushed around by the label beside it, and it always reads as the row's
		// own handle rather than as a control between two others.
		const gripStyle = {
			background: "none",
			border: 0,
			color: "inherit",
			cursor: "grab",
			"font-size": "14px",
			"line-height": 1,
			opacity: 0.45,
			padding: "0 2px",
			position: "absolute",
			right: 0,
			top: "50%",
			transform: "translateY(-50%)",
			"user-select": "none",
		} as const;
		// A credential row is two lines: who it is, then what you can do to it.
		// The second line carries the provider's own words on the left, so a
		// failure is readable without hovering the marker.
		const stackRow = {
			"align-items": "stretch",
			display: "flex",
			"flex-direction": "column",
			gap: "2px",
		} as const;
		// That second line reserves the grip's gutter itself, so the handle sits
		// level with the switches rather than between the two lines.
		const controlLine = {
			"align-items": "center",
			display: "flex",
			gap: "6px",
			"padding-right": "1.4em",
			position: "relative",
		} as const;
		// The note's box: the control line's left side, and the thing a pointer
		// clicks to read the whole message. It is a column because the attempt
		// time sits under the message once it is open.
		const detail = {
			cursor: "pointer",
			display: "flex",
			flex: "1 1 auto",
			"flex-direction": "column",
			"font-size": "12px",
			gap: "2px",
			"min-width": 0,
			opacity: 0.7,
		} as const;
		// Closed it is one line ending in an ellipsis, like every other row
		// label; open it wraps, so a long provider message is all there.
		const detailLine = (open: boolean) =>
			({
				overflow: "hidden",
				"overflow-wrap": "anywhere",
				"text-overflow": "ellipsis",
				"white-space": open ? "pre-wrap" : "nowrap",
			}) as const;
		// The attempt time, under the message rather than beside it: the message
		// is what a person opened this for.
		const attempt = {
			"font-size": "11px",
			opacity: 0.8,
		} as const;
		// The row's own switches, pulled together at its right edge beside the grip
		// and divided from the label by a hairline: a row reads as "this credential"
		// on the left and "what you can do to it" on the right.
		const controls = {
			"align-items": "center",
			display: "flex",
			gap: "6px",
			"margin-left": "auto",
		} as const;
		// The hairline itself, in the text colour so it follows the theme.
		const rule = {
			"align-self": "stretch",
			"border-left": "1px solid currentColor",
			opacity: 0.15,
			width: 0,
		} as const;
		/** The row a drag would land on, and the row being dragged. */
		const rowWhileDragging = (
			list: string,
			index: number,
			base: typeof grabbableRow | typeof stackRow = grabbableRow,
		) => {
			const current = dragging();
			if (!current || current.list !== list) return base;
			if (current.from === index) return { ...base, opacity: 0.55 };
			if (current.to === index) {
				return {
					...base,
					"box-shadow": "inset 0 2px 0 currentColor",
				};
			}
			return base;
		};
		const grip = (input: {
			list: string;
			index: number;
			count: number;
			move: (to: number) => void;
		}) => ({
			"aria-label": "reorder",
			onKeyDown: (event: KeyboardEvent) => {
				if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
				const to = input.index + (event.key === "ArrowUp" ? -1 : 1);
				if (to < 0 || to >= input.count) return;
				event.preventDefault();
				input.move(to);
			},
			onPointerDown: (event: PointerEvent) => {
				if (event.button !== 0) return;
				event.preventDefault();
				const previousSelect = document.body.style.userSelect;
				document.body.style.userSelect = "none";
				setDragging({ from: input.index, list: input.list, to: input.index });
				const track = (move: PointerEvent) => {
					const to = rowUnder(input.list, move.clientX, move.clientY);
					if (to !== undefined) {
						setDragging((current) => (current ? { ...current, to } : current));
					}
				};
				const end = () => {
					const current = dragging();
					window.removeEventListener("pointermove", track);
					window.removeEventListener("pointerup", end);
					window.removeEventListener("pointercancel", end);
					document.body.style.userSelect = previousSelect;
					setDragging(null);
					if (current && current.from !== current.to) input.move(current.to);
				};
				window.addEventListener("pointermove", track);
				window.addEventListener("pointerup", end);
				window.addEventListener("pointercancel", end);
			},
			role: "button" as const,
			style: gripStyle,
			tabIndex: 0,
			title:
				"drag to reorder; with this focused, the arrow keys move it one place",
		});

		// The providers section is one row per credential, in the balancer's
		// order: the order, the switches and the grip all act on the
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

		// The refill the endpoint named, when it named one. A park with no words,
		// or words with no time in them, has nothing to say, so this stays
		// undefined rather than inventing a moment.
		const rollover = (account?: Account) =>
			account?.limited && account.limitedUntil > 0
				? account.limitedUntil
				: undefined;

		// What the control line says, left of the switches: the refill the
		// endpoint named and the provider's own words when it refused. The marker
		// above clears on the next attempt, so this reports the last attempt
		// rather than predicting the next one.
		const rowNote = (account?: Account) =>
			credentialNote({
				limited: Boolean(account?.limited),
				limitedUntil: rollover(account),
				reason: account?.limitedReason,
				resets: ctx.t("resets"),
			});

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
							style={{
								"align-items": "center",
								display: "flex",
								gap: "4px",
								"margin-left": "auto",
							}}
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

					{/* The switch and the length are separate controls on purpose: the
					    toggle says whether idleness drops a trail at all, the field
					    says after how long. The clock is measured from the last
					    routed request, so it is idleness that ages a trail out, not
					    elapsed time — a session that keeps talking never reaches it. */}
					<div style={row}>
						<label
							style={{ "align-items": "center", display: "flex", gap: "4px" }}
							title="drop a session's failover trail once it has sat idle for the time beside this, so the order starts again from the head. Off means nothing ages a trail out by itself; only a change to the order — a pick, a reorder, a switch, a chain edit — starts a session over."
						>
							<input
								checked={rebalanceAuto()}
								onChange={(event) =>
									void run(() =>
										rpc().setRebalanceAuto({
											enabled: event.currentTarget.checked,
										}),
									)
								}
								type="checkbox"
							/>
							{ctx.t("rebalance")}
						</label>
						<input
							onBlur={commitRebalance}
							onInput={(event) => setRebalanceDraft(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							placeholder={formatDuration(DEFAULT_REBALANCE_MS)}
							style={{ width: "4.5em" }}
							title="how long a session may sit idle before its failover trail is dropped: 90m, 5h, 1d 2h; empty keeps the built-in 5h. 0 turns the switch off, and any length typed here turns it back on."
							value={rebalanceDraft()}
						/>
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
						<Show when={bufferTokens(bufferDraft()) > 0}>
							<span
								style={{ opacity: 0.6 }}
								title="what the buffer works out to"
							>
								{formatTokens(bufferTokens(bufferDraft()))}
							</span>
						</Show>
						{/* Where the limit and the buffer land, labelled: a bare
						    number beside them read as belonging to neither, and it
						    is neither — it is where the cut actually falls. */}
						<Show when={cutTokens() > 0}>
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
									title="where the cut actually lands: the limit, less the buffer where the buffer is enforced. A model whose real window is smaller is cut below this, and one whose window is unknown is measured against the declared 1M."
								>
									{ctx.t("at")}
								</span>
								<span style={{ opacity: 0.6 }}>
									{formatTokens(cutTokens())}
								</span>
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
							<span style={selectWrap}>
								<select
									onChange={(event) =>
										void run(() =>
											rpc().setBufferEnforce({
												value: event.currentTarget.value,
											}),
										)
									}
									style={{ ...select, width: "10.5em" }}
									title="when the buffer is enforced: always takes it off every cut, when necessary only where the limit has reached what the model can hold"
									value={bufferEnforce()}
								>
									<option value="always">{ctx.t("always")}</option>
									<option value="necessary">{ctx.t("necessary")}</option>
								</select>
								<span style={selectArrow}>▾</span>
							</span>
						</span>
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
							<div
								data-reorder="providers"
								data-reorder-index={index()}
								style={rowWhileDragging("providers", index(), stackRow)}
							>
								<label
									style={{
										"align-items": "center",
										display: "flex",
										gap: "4px",
									}}
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
													{routeMarkers({
														active: account().active,
														inUse: account().inUse,
														limited: account().limited,
													}).map((marker) => (
														<span
															title={
																marker === "limited"
																	? account().limitedReason || undefined
																	: undefined
															}
														>
															{` · ${ctx.t(marker)}`}
														</span>
													))}
												</>
											)}
										</Show>
									</span>
								</label>
								<div style={controlLine}>
									<Show when={rowNote(item.account)}>
										{(note) => {
											const key = `${item.entry.providerID}/${item.entry.alias}`;
											const open = () => openNote() === key;
											const toggle = () => setOpenNote(open() ? "" : key);
											return (
												<div
													aria-expanded={open()}
													onClick={toggle}
													onKeyDown={(event) => {
														if (event.key !== "Enter" && event.key !== " ")
															return;
														event.preventDefault();
														toggle();
													}}
													role="button"
													style={detail}
													tabIndex={0}
													title={
														open()
															? "hide the message"
															: "show the whole message and when this credential was last tried"
													}
												>
													<span style={detailLine(open())}>
														{open() ? "▾" : "▸"} {note()}
													</span>
													<Show when={open()}>
														<div style={attempt}>
															{`${ctx.t("lastTried")} ${formatAttempt(item.account?.lastUsedAt)}`}
														</div>
													</Show>
												</div>
											);
										}}
									</Show>
									<span style={controls}>
										<span style={rule} />
										<label
											style={{
												"align-items": "center",
												display: "flex",
												gap: "4px",
											}}
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
											onClick={() =>
												void run(() =>
													rpc().use({
														alias: item.entry.alias,
														providerID: item.entry.providerID,
													}),
												)
											}
											style={button}
											title="serve this provider with this credential; picking a parked one clears its cooldown"
										>
											{ctx.t("use")}
										</button>
									</span>

									{/* Last in the row and out of its flow: the grip sits in the
								    reserved right-hand gutter, and the final tab stop is the
								    handle rather than a control that acts on the credential. */}
									<span
										{...grip({
											count: providerEntries().length,
											index: index(),
											list: "providers",
											move: (to) =>
												void run(() =>
													rpc().move({
														alias: item.entry.alias,
														providerID: item.entry.providerID,
														to,
													}),
												),
										})}
									>
										⠿
									</span>
								</div>
							</div>
						)}
					</For>

					<div style={divider} />

					<div style={{ ...row, "margin-top": "4px" }}>
						<button
							onClick={toggleModels}
							style={{ ...button, "min-width": "1.4em" }}
							title={modelsOpen() ? ctx.t("collapse") : ctx.t("expand")}
						>
							{modelsOpen() ? "▾" : "▸"}
						</button>
						<strong
							onClick={toggleModels}
							style={titleToggle}
							title={modelsOpen() ? ctx.t("collapse") : ctx.t("expand")}
						>
							{ctx.t("models")}
						</strong>
						<button
							onClick={toggleCreate}
							style={{ ...button, "margin-left": "auto" }}
							title={
								creating() ? "discard this chain draft" : "start a new chain"
							}
						>
							{creating() ? ctx.t("cancel") : `+ ${ctx.t("newChain")}`}
						</button>
						<button
							onClick={toggleAll}
							style={button}
							title={allCollapsed() ? ctx.t("expand") : ctx.t("collapse")}
						>
							{allCollapsed() ? ctx.t("expand") : ctx.t("collapse")}
						</button>
					</div>

					<Show when={modelsOpen()}>
						<Show when={creating()}>
							<div style={row}>
								<span style={{ ...field, ...selectWrap }}>
									<select
										onChange={(event) =>
											void chooseCreateProvider(event.currentTarget.value)
										}
										style={select}
										value={createProvider()}
									>
										<option value="">provider</option>
										<For each={providers()}>
											{(entry) => (
												<option value={entry.providerID}>{entry.name}</option>
											)}
										</For>
									</select>
									<span style={selectArrow}>▾</span>
								</span>
								<span style={{ ...field, ...selectWrap }}>
									<select
										onChange={(event) =>
											void run(() =>
												rpc().chainCreate({
													modelID: event.currentTarget.value,
													providerID: createProvider(),
												}),
											).then(cancelCreate)
										}
										style={select}
										value=""
									>
										<option value="">model</option>
										<For each={createModels()}>
											{(model) => (
												<option value={model.modelID}>{model.name}</option>
											)}
										</For>
									</select>
									<span style={selectArrow}>▾</span>
								</span>
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
												style={{ ...button, "min-width": "1.4em" }}
												title={
													isGroupCollapsed(group.brand ?? "")
														? ctx.t("expand")
														: ctx.t("collapse")
												}
											>
												{isGroupCollapsed(group.brand ?? "") ? "▸" : "▾"}
											</button>
											<strong
												onClick={() => toggleGroup(group.brand ?? "")}
												style={titleToggle}
												title={
													isGroupCollapsed(group.brand ?? "")
														? ctx.t("expand")
														: ctx.t("collapse")
												}
											>
												{group.brand}
											</strong>
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
																style={{ ...button, "min-width": "1.4em" }}
																title={
																	isCollapsed(chain.key) ? "expand" : "collapse"
																}
															>
																{isCollapsed(chain.key) ? "▸" : "▾"}
															</button>
															<span
																onClick={() => toggleCollapsed(chain.key)}
																style={{
																	...titleToggle,
																	flex: "1 1 140px",
																	"min-width": 0,
																	"overflow-wrap": "anywhere",
																}}
																title={
																	isCollapsed(chain.key)
																		? ctx.t("expand")
																		: ctx.t("collapse")
																}
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
															<span style={{ opacity: 0.7 }}>
																{ctx.t("limit")}
															</span>
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
																	style={button}
																>
																	{ctx.t("reset")}
																</button>
															</Show>
														</div>

														<Show when={!isCollapsed(chain.key)}>
															<div style={stair(1)}>
																<For each={chain.targets}>
																	{(target, index) => (
																		<div
																			data-reorder={`targets:${chain.key}`}
																			data-reorder-index={index()}
																			style={rowWhileDragging(
																				`targets:${chain.key}`,
																				index(),
																			)}
																		>
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
																				{/* The target the balancer would send the
																				    next request to — the model currently
																				    selected for this row. Only one target
																				    carries the mark; a healthy one that is
																				    not it says nothing. */}
																				<Show
																					when={target.state !== "available"}
																				>
																					<span style={{ opacity: 0.6 }}>
																						{" "}
																						· {target.state}
																					</span>
																				</Show>
																			</span>
																			<span
																				{...grip({
																					count: chain.targets.length,
																					index: index(),
																					list: `targets:${chain.key}`,
																					move: (to) =>
																						void run(() =>
																							rpc().chainMove({
																								key: chain.key,
																								providerID: target.providerID,
																								to,
																							}),
																						),
																				})}
																			>
																				⠿
																			</span>
																			<button
																				onClick={() =>
																					void run(() =>
																						rpc().chainRemove({
																							key: chain.key,
																							providerID: target.providerID,
																						}),
																					)
																				}
																				style={button}
																				title="remove target"
																			>
																				×
																			</button>
																		</div>
																	)}
																</For>

																<Show
																	fallback={
																		<button
																			disabled={
																				addableProviders(chain).length === 0
																			}
																			onClick={() => void startAdd(chain.key)}
																			style={button}
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
																				<button
																					onClick={() => setAdding("")}
																					style={button}
																				>
																					cancel
																				</button>
																			</div>
																		}
																		when={addableProviders(chain).length > 0}
																	>
																		<div style={row}>
																			<span style={{ ...field, ...selectWrap }}>
																				<select
																					onChange={(event) =>
																						void chooseProvider(
																							event.currentTarget.value,
																						)
																					}
																					style={select}
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
																				<span style={selectArrow}>▾</span>
																			</span>
																			<span style={{ ...field, ...selectWrap }}>
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
																					style={select}
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
																				<span style={selectArrow}>▾</span>
																			</span>
																			<button
																				onClick={() => setAdding("")}
																				style={button}
																			>
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
						<button onClick={() => setDiagOpen(!diagOpen())} style={button}>
							{diagOpen() ? "▾" : "▸"} {ctx.t("diagnostics")}
						</button>
						<span style={{ opacity: 0.5 }}>{logEntries().length}</span>
						<button
							onClick={() => void refresh()}
							style={{ ...button, "margin-left": "auto" }}
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
									style={{ ...button, "align-self": "flex-start" }}
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
