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
import {
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { copy } from "./copy";
import { mergeChainGroups, mergeChainRows } from "./core/chain-view";
import {
	bufferTokens,
	cutFor,
	formatTokens,
	MAX_PERCENT,
} from "./core/context";
import { credentialDetail, formatAttempt, routeMarkers } from "./core/format";
import { groupByBrand } from "./core/models";
import {
	DEFAULT_REBALANCE_MS,
	formatDuration,
	formatRemaining,
} from "./core/rebalance";
import { Balancer } from "./rpc";
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

/**
 * Whether two provider reads are the same list.
 *
 * The panel polls this list every couple of seconds so a credential imported or
 * rotated while it is open shows up without a click. Re-rendering an unchanged
 * list would restart every row on the poll, so the poll only writes when
 * something actually differs.
 */
function sameProviders(left: readonly Provider[], right: readonly Provider[]) {
	if (left.length !== right.length) return false;
	return left.every((entry, index) => {
		const other = right[index];
		return (
			other !== undefined &&
			entry.alias === other.alias &&
			entry.enabled === other.enabled &&
			entry.freeOnly === other.freeOnly &&
			entry.name === other.name &&
			entry.position === other.position &&
			entry.providerID === other.providerID
		);
	});
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
		// How long a row holds its balance before it checks the head of the
		// order again, as typed: `90m`, `5h`. Empty means the built-in window.
		// The toggle above the field says whether the clock runs at all; the
		// field says how long.
		const [rebalance, setRebalance] = createSignal("");
		const [rebalanceAuto, setRebalanceAuto] = createSignal(true);
		const [rebalanceDraft, setRebalanceDraft] = createSignal("");
		// When the client's balance next lapses, in ms; 0 when nothing is
		// counting down. Read from the server, which is where the trails live.
		const [rebalanceNextAt, setRebalanceNextAt] = createSignal(0);
		// The wall clock the countdown is read against. `nextAt` is absolute and
		// every poll writes the same number back, so a countdown evaluated only
		// when that signal changes would freeze: Solid skips a set whose value it
		// already holds. This changes on every poll and re-renders only the note.
		const [clock, setClock] = createSignal(Date.now());
		const [message, setMessage] = createSignal("");
		const [chains, setChains] = createSignal<Chain[]>([]);
		// A row's limit as it is being typed. Kept apart from the row because the
		// panel re-reads rows on a timer: the poll must be able to refresh targets
		// and markers without reaching into a field somebody is typing in.
		const [limitDrafts, setLimitDrafts] = createSignal<Record<string, string>>(
			{},
		);

		/**
		 * Fold freshly read rows into what is on screen.
		 *
		 * A whole replacement would drop a limit mid-edit, which is why the limit
		 * lives in its own draft; everything else on a row is the server's to
		 * decide. Rows are matched by key, so one that appeared or vanished since
		 * the last read is picked up instead of leaving the panel showing a
		 * snapshot taken while the catalogue was still being assembled.
		 */
		const mergeChains = (rows: Chain[]) => {
			const drafts = limitDrafts();
			const merged =
				Object.keys(drafts).length === 0
					? rows
					: rows.map((row) =>
							drafts[row.key] === undefined
								? row
								: { ...row, limit: drafts[row.key] },
						);
			// Kept by identity where nothing changed: a poll that rebuilt every
			// row closed the model picker the moment it was opened, because the
			// `<select>` left the document under the pointer.
			setChains(mergeChainRows(chains(), merged));
		};
		const [providers, setProviders] = createSignal<Provider[]>([]);
		// What is being served right now, one entry per row. More than one is
		// normal: a model split across providers, or two conversations on
		// different models, both show here rather than as a single "in use".
		const [inUse, setInUse] = createSignal<InUseEntry[]>([]);
		// The row whose add form is open, plus what the user has picked in it.
		const [adding, setAdding] = createSignal("");
		// Which credential's note is open, as `provider/alias`: one at a time, so
		// the panel cannot fill with expanded messages.
		const [openNote, setOpenNote] = createSignal("");
		// Which chain target is showing its id instead of its name, as
		// `row:provider`. The name is what a person reads for; the id is what the
		// provider is actually sent, and a click swaps between them rather than
		// printing both beside each other.
		const [openId, setOpenId] = createSignal("");
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
				const [
					status,
					list,
					rows,
					order,
					settings,
					room,
					rebalance,
					log,
					serving,
				] = await Promise.all([
					rpc.status({}),
					rpc.list({}),
					rpc.chains({}),
					rpc.priority({}),
					rpc.contextLimit({}),
					rpc.contextBuffer({}),
					rpc.rebalance({}),
					rpc.log({}),
					rpc.inUse({}),
				]);
				setBalancing((status as Status).balancing);
				setAccounts([...(list as Listed).accounts]);
				setLogEntries([...(log as { entries: LogEntry[] }).entries]);
				// A full read must not rebuild a row that says the same thing: the
				// add form and the pickers live inside rows.
				setChains(mergeChainRows(chains(), [...(rows as Chains).rows]));
				setInUse([...(serving as InUse).entries]);
				setLimitDrafts({});
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
				setRebalance((rebalance as RebalanceState).value);
				setRebalanceAuto((rebalance as RebalanceState).auto);
				setRebalanceDraft((rebalance as RebalanceState).value);
				setRebalanceNextAt((rebalance as RebalanceState).nextAt);
				setLastRefreshed(Date.now());
			} catch (error) {
				setMessage(describe(error));
			}
		};

		// "in use" is the account the router is pointed at right now, and the log
		// grows as requests move and fail over.
		//
		// The rows are re-read too, merged rather than replaced: they are what says
		// which model served and where, and a panel mounted while the catalogue was
		// still being built otherwise shows its first snapshot until somebody
		// clicks. The merge exists so a poll cannot clobber a field being typed
		// into: the limit belongs to its own draft, and every other field here
		// comes from the server.
		const refreshInUse = async () => {
			try {
				const rpc = ctx.client.rpc(Balancer);
				const [list, log, rows, order, serving, rebalance] = await Promise.all([
					rpc.list({}),
					rpc.log({}),
					rpc.chains({}),
					rpc.priority({}),
					rpc.inUse({}),
					rpc.rebalance({}),
				]);
				setAccounts([...(list as Listed).accounts]);
				setLogEntries([...(log as { entries: LogEntry[] }).entries]);
				mergeChains((rows as Chains).rows);
				setInUse([...(serving as InUse).entries]);
				setRebalanceNextAt((rebalance as RebalanceState).nextAt);
				// The provider list is where a credential appears, and a sync that
				// imports one runs after the panel mounted. Reading it only on the
				// full refresh left a new provider invisible until somebody
				// clicked, and a credential the host had rotated invisible until
				// then too. The comparison keeps a two-second poll from
				// re-rendering a list that has not changed.
				const entries = [...(order as Providers).entries];
				if (!sameProviders(providers(), entries)) setProviders(entries);
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

		/**
		 * The real window of the model the routed session is on, when that model
		 * is a balancer row.
		 *
		 * Every row declares 1M to the host so the balancer can compact on its own
		 * schedule, but the request still lands in a provider's real window. A cut
		 * readout that stops at the limit would promise room the serving model
		 * does not have, which is exactly the overflow the buffer exists to
		 * prevent.
		 *
		 * The row's own figure is the tightest of its targets, because the next
		 * request may land on any of them. When one target is serving, that is the
		 * window the conversation actually has until it moves: reading the row's
		 * minimum there cut a 1M model at a 200k sibling's window and reported
		 * 168k for a conversation nowhere near its limit.
		 */
		const currentRowContext = () => {
			const model = ctx.screen.current()?.composer.model();
			if (model?.providerID !== "balancer") return undefined;
			const row = chains().find((chain) => chain.key === model.modelID);
			if (!row) return undefined;
			const serving = inUse().find((entry) => entry.familyKey === row.key);
			const target = serving
				? row.targets.find((entry) => entry.providerID === serving.providerID)
				: undefined;
			if (target && target.context > 0) return target.context;
			return row.context > 0 ? row.context : undefined;
		};

		const cutTokens = () =>
			cutFor(
				globalLimitDraft(),
				bufferDraft(),
				bufferEnforce(),
				currentRowContext(),
			);

		const storedCut = () =>
			cutFor(globalLimit(), buffer(), bufferEnforce(), currentRowContext());

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
		// the provider can actually route — and, when the row's wire format is
		// known, only the ones that format can carry.
		const chooseProvider = async (providerID: string, wire?: string) => {
			setAddProvider(providerID);
			setAddModels([]);
			if (!providerID) return;
			try {
				const reply = (await rpc().chainModels({
					package: wire,
					providerID,
				})) as Models;
				setAddModels(sortByName(reply.models));
			} catch (error) {
				setMessage(describe(error));
			}
		};

		const chooseCreateProvider = async (providerID: string, wire?: string) => {
			setCreateProvider(providerID);
			setCreateModels([]);
			if (!providerID) return;
			try {
				const reply = (await rpc().chainModels({
					package: wire,
					providerID,
				})) as Models;
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
		// Brand headers are new objects on every read; handing back the previous
		// ones when nothing moved keeps the rows inside them in the document,
		// which is what an open picker needs.
		let lastGroups: Array<{ brand?: string; rows: Chain[] }> = [];
		const groupedChains = createMemo(() => {
			lastGroups = mergeChainGroups(lastGroups, groupByBrand(visibleChains()));
			return lastGroups;
		});

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

		// Reordering is two buttons, one step each.
		//
		// A single drag handle replaced a pair of arrows, and in this panel the
		// handle never received a usable gesture: three rebuilds — a row-wide
		// start, pointer capture, and drop slots taken from the rows' own
		// rectangles — each left a real drag doing nothing. A control nobody can
		// use is worse than the plainer one it replaced, so the arrows are back
		// and they call the same RPC the drag would have.
		const stepper = {
			"align-items": "center",
			display: "inline-flex",
			gap: "2px",
		} as const;
		const stepButton = {
			background: "none",
			border: 0,
			color: "inherit",
			cursor: "pointer",
			"font-size": "11px",
			"line-height": 1,
			opacity: 0.6,
			padding: "0 1px",
		} as const;
		// A reorderable row keeps a gutter at its right edge, so the stepper is in
		// the same place on every row instead of wherever a wrapping label leaves it.
		const grabbableRow = {
			...row,
			"padding-right": "2.6em",
			position: "relative",
		} as const;
		// The stepper sits in that gutter rather than in the flow: it cannot be
		// pushed around by the label beside it, and it reads as the row's own
		// control rather than as a control between two others.
		const stepperBox = {
			...stepper,
			position: "absolute",
			right: 0,
			top: "50%",
			transform: "translateY(-50%)",
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
		// That second line reserves the stepper's gutter itself, so it sits
		// level with the switches rather than between the two lines.
		const controlLine = {
			"align-items": "center",
			display: "flex",
			gap: "6px",
			"padding-right": "2.6em",
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
		// The row's own switches, pulled together at its right edge beside the stepper
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
		/** What a step asks the balancer to do, for one credential. */
		const moveProvider = (providerID: string, alias: string) => (to: number) =>
			void run(() => rpc().move({ alias, providerID, to }));

		/**
		 * One row's reorder controls: a step up and a step down.
		 *
		 * Both appear on every row, disabled at the ends rather than hidden, so
		 * the control does not move under the pointer as the row it belongs to
		 * changes place.
		 */
		const Stepper = (props: {
			index: number;
			count: number;
			move: (to: number) => void;
		}) => (
			<span style={stepperBox}>
				<button
					aria-label="move up"
					disabled={props.index === 0}
					onClick={() => props.move(props.index - 1)}
					style={stepButton}
					title="move up one place"
				>
					↑
				</button>
				<button
					aria-label="move down"
					disabled={props.index >= props.count - 1}
					onClick={() => props.move(props.index + 1)}
					style={stepButton}
					title="move down one place"
				>
					↓
				</button>
			</span>
		);

		// The providers section is one row per credential, in the balancer's
		// order: the order, the switches and the stepper all act on the
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

		// What the control line says, left of the switches: what this credential
		// last refused, or failing that the model it is serving and when. The
		// panel has no status line of its own, so this box is the only place a
		// credential says it is the one in use.
		const rowNote = (entry: Provider, account?: Account) =>
			credentialDetail({
				account,
				alias: entry.alias,
				now: Date.now(),
				providerID: entry.providerID,
				resets: ctx.t("resets"),
				serving: inUse(),
			});

		const View = () => {
			onMount(() => {
				void refresh();
				const timer = setInterval(() => {
					setClock(Date.now());
					void refreshInUse();
				}, 2000);
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
					    toggle says whether the periodic check runs at all, the field
					    says after how long. The clock runs from the last check, not
					    from the last request, so a conversation that keeps talking
					    still gives a cheaper target at the head another chance. */}
					<div style={row}>
						<label
							style={{ "align-items": "center", display: "flex", gap: "4px" }}
							title="check the head of the order again after the time beside this, so a cheaper target that has recovered is used again. Off means only a change to the order — a pick, a reorder, a switch, a chain edit — moves a row."
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
							title="how long a row holds its balance before checking the head of the order again: 90m, 5h, 1d 2h; empty keeps the built-in 5h. 0 turns the switch off, and any length typed here turns it back on."
							value={rebalanceDraft()}
						/>
						{/* When the row next checks the head, which is the question the
						    field is asking: the window measured from the last check.
						    Nothing counting down means nothing is in flight yet, or
						    the switch is off. */}
						<Show when={rebalanceNextAt() > clock()}>
							<span
								style={{ opacity: 0.7 }}
								title="how long until the row checks the head of the order again, measured from the last check"
							>
								{`(in ${formatRemaining(rebalanceNextAt() - clock())})`}
							</span>
						</Show>
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
									title="where the cut actually lands: the limit, less the buffer where the buffer is enforced. Measured against the tightest window this row's targets report, so a model below the limit is cut at what it can actually hold; a row whose window is unknown is measured against the declared 1M."
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

					<div style={divider} />

					<div style={row}>
						<strong title="one row per credential, in the order routing tries them. active = the balancer can send here; pending = you picked it for the next request; in use = it served the most recent request; limited = parked after a failure — hover a marker for the reason. Two credentials on one provider are two rows, and each is tried in turn.">
							{ctx.t("providers")}
						</strong>
					</div>

					<For each={providerEntries()}>
						{(item, index) => (
							<div style={stackRow}>
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
														pending: account().pending,
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
									<Show when={rowNote(item.entry, item.account)}>
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
															? "hide the detail"
															: "show the whole line and when this credential was last tried"
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
											title="borrow the window of an identically named model on another provider when this one publishes none"
										>
											<input
												checked={item.entry.assumeWindows}
												onChange={(event) =>
													void run(() =>
														rpc().setAssumeWindows({
															enabled: event.currentTarget.checked,
															providerID: item.entry.providerID,
														}),
													)
												}
												type="checkbox"
											/>
											{ctx.t("assumeWindows")}
										</label>
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

									{/* Last in the row and out of its flow: the stepper sits in the
								    reserved right-hand gutter, level with the switches. */}
									<Stepper
										count={providerEntries().length}
										index={index()}
										move={moveProvider(item.entry.providerID, item.entry.alias)}
									/>
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
																onInput={(event) => {
																	setLimitDrafts({
																		...limitDrafts(),
																		[chain.key]: event.currentTarget.value,
																	});
																}}
																onKeyDown={(event) => {
																	if (event.key === "Enter")
																		event.currentTarget.blur();
																}}
																placeholder={ctx.t("globalShare")}
																style={{ width: "5em" }}
																title={`this model's own limit: a size in thousands — 200 is two hundred thousand — or a share of its real window, 1% to ${MAX_PERCENT}%; empty follows the global limit`}
																value={limitDrafts()[chain.key] ?? chain.limit}
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
																		<div style={grabbableRow}>
																			<span
																				onClick={() => {
																					const key = `${chain.key}:${target.providerID}`;
																					setOpenId(
																						openId() === key ? "" : key,
																					);
																				}}
																				style={{
																					cursor: "pointer",
																					flex: "1 1 140px",
																					"min-width": 0,
																					"overflow-wrap": "anywhere",
																				}}
																				title={
																					openId() ===
																					`${chain.key}:${target.providerID}`
																						? "show the model's name"
																						: "show the id this provider is sent"
																				}
																			>
																				{index() + 1}. {target.providerID} ·{" "}
																				{openId() ===
																				`${chain.key}:${target.providerID}`
																					? target.resolved
																					: target.name || target.resolved}
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
																				{/* A window nobody published is not a number; say
																				    so instead of showing a default. A borrowed one
																				    names the connector it came from. */}
																				<Show
																					when={
																						target.contextSource ===
																							"assumed" || target.context === 0
																					}
																				>
																					<span style={{ opacity: 0.6 }}>
																						{target.contextSource === "assumed"
																							? ` · ${formatTokens(target.context)} ${ctx.t("assumedFrom")} ${target.assumedFrom}`
																							: ` · ${ctx.t("unknownWindow")}`}
																					</span>
																				</Show>
																			</span>
																			<Stepper
																				count={chain.targets.length}
																				index={index()}
																				move={(to) =>
																					void run(() =>
																						rpc().chainMove({
																							key: chain.key,
																							providerID: target.providerID,
																							to,
																						}),
																					)
																				}
																			/>
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
																							chain.package,
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
