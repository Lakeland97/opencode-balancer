import { Rpc } from "@opencode/plugin/rpc";
import type { JsonSchema } from "effect";

const str: JsonSchema.JsonSchema = { type: "string" };
const bool: JsonSchema.JsonSchema = { type: "boolean" };
const num: JsonSchema.JsonSchema = { type: "number" };

/** A JSON schema that is known to describe an object, as events require. */
type ObjectSchema = JsonSchema.JsonSchema & { readonly type: "object" };

function object(
	properties: Record<string, JsonSchema.JsonSchema>,
	required: string[] = [],
): ObjectSchema {
	return { additionalProperties: false, properties, required, type: "object" };
}

const empty = object({});
const pair = object({ alias: str, providerID: str }, ["providerID", "alias"]);
const result = object({ message: str, ok: bool }, ["ok", "message"]);
const chainTarget = object(
	{
		/** The connector a window was borrowed from, empty when it was not. */
		assumedFrom: str,
		/**
		 * The window this target reports, or 0 when it reports none. The row's own
		 * `context` is the tightest of these, which is why the panel can say why a
		 * row is cut where it is.
		 */
		context: num,
		/** Where that window came from: published, declared, assumed or unknown. */
		contextSource: str,
		modelID: str,
		/** The connector's own name for the model, empty when it published none. */
		name: str,
		providerID: str,
		/** The model actually sent, once a free-only provider substitutes. */
		resolved: str,
		state: str,
	},
	[
		"providerID",
		"modelID",
		"name",
		"context",
		"contextSource",
		"assumedFrom",
		"resolved",
		"state",
	],
);
const chainRow = object(
	{
		/**
		 * The smallest window any target of this row reports, or 0 when none
		 * reports one. The row declares 1M to the host, but this is what the
		 * conversation can actually be sent into, so a readout that clamps a cut
		 * to it is describing the request and not the declaration.
		 */
		context: num,
		key: str,
		label: str,
		/**
		 * The user's own limit for this model — a size in thousands or a share of
		 * its window — as typed, empty when it follows the global. One value per
		 * model, not per credential: who answers does not change what the model
		 * holds.
		 */
		limit: str,
		package: str,
		stored: bool,
		targets: { items: chainTarget, type: "array" },
	},
	["key", "label", "package", "limit", "stored", "targets", "context"],
);
const logEntry = object(
	{
		at: num,
		/** route, failover, config, compact or error. */
		kind: str,
		text: str,
	},
	["at", "kind", "text"],
);
const account = object(
	{
		active: bool,
		alias: str,
		disabled: bool,
		failures: num,
		inUse: bool,
		lastUsedAt: num,
		limited: bool,
		/** What the endpoint said when it parked the account, empty when fine. */
		limitedReason: str,
		/** When the endpoint said its quota returns, in ms; 0 when it did not say. */
		limitedUntil: num,
		providerID: str,
	},
	["providerID", "alias", "active", "disabled", "limited", "failures"],
);

/**
 * Typed surface for clients (GUI part, TUI, SDK) to manage accounts without
 * parsing command output.
 */
export const balancerDefinition = {
	events: {
		// Lets the server-side command surface ask an open Desktop window to
		// reveal the panel; a terminal-only session simply has no listener.
		open: { schema: empty },
	},
	id: "balancer",
	methods: {
		chainAdd: {
			input: object({ key: str, modelID: str, providerID: str }, [
				"key",
				"providerID",
				"modelID",
			]),
			output: result,
		},

		chainCreate: {
			input: object({ modelID: str, providerID: str }, [
				"providerID",
				"modelID",
			]),
			output: object({ key: str, message: str, ok: bool }, [
				"ok",
				"message",
				"key",
			]),
		},
		chainModels: {
			input: object({ package: str, providerID: str }, ["providerID"]),
			output: object(
				{
					models: {
						items: object({ modelID: str, name: str }, ["modelID", "name"]),
						type: "array",
					},
				},
				["models"],
			),
		},
		chainMove: {
			input: object(
				{
					/** One place up or down. */
					direction: { enum: ["up", "down"], type: "string" },
					key: str,
					providerID: str,
					/** The slot to land on, which is what a drag or a stepper names. */
					to: num,
				},
				["key", "providerID"],
			),
			output: result,
		},
		chainRemove: {
			input: object({ key: str, providerID: str }, ["key", "providerID"]),
			output: result,
		},
		chainReset: {
			input: object({ key: str }, ["key"]),
			output: result,
		},
		chains: {
			input: empty,
			output: object({ rows: { items: chainRow, type: "array" } }, ["rows"]),
		},
		clearLog: { input: empty, output: result },
		contextBuffer: {
			input: empty,
			// What the reserve below the cut is, as typed, empty for the built-in
			// rule; `enforce` says whether it comes off every cut or only where
			// the limit has reached what the model holds.
			output: object({ enforce: str, value: str }, ["value", "enforce"]),
		},
		contextLimit: {
			input: empty,
			// A size in thousands or a share of the declared window the balancer
			// compacts at, as the user typed it; empty means the built-in value.
			// A model may override it with a limit of its own.
			output: object({ value: str }, ["value"]),
		},
		inUse: {
			input: empty,
			output: object(
				{
					entries: {
						items: object(
							{
								/** The agent that made the call, e.g. `build`. */
								agent: str,
								/** The credential serving this row, when it is known. */
								alias: str,
								/** The level actually applied on the connector, or empty. */
								applied: str,
								/** When this row last served, in ms. */
								at: num,
								/** The row's stable key, e.g. `deepseek-v4.1-flash`. */
								familyKey: str,
								/** The row's label as the picker shows it. */
								label: str,
								/** The connector's own model id, after any free swap. */
								modelID: str,
								providerID: str,
								/** The thinking level that request asked for, or empty. */
								variant: str,
								/** True while a request to this target is still open. */
								working: bool,
							},
							[
								"providerID",
								"familyKey",
								"label",
								"modelID",
								"alias",
								"agent",
								"applied",
								"variant",
								"at",
								"working",
							],
						),
						type: "array",
					},
				},
				["entries"],
			),
		},
		list: {
			input: object({ providerID: str }),
			output: object({ accounts: { items: account, type: "array" } }, [
				"accounts",
			]),
		},
		log: {
			input: empty,
			output: object({ entries: { items: logEntry, type: "array" } }, [
				"entries",
			]),
		},
		move: {
			input: object(
				{
					alias: str,
					/** One place up or down. */
					direction: { enum: ["up", "down"], type: "string" },
					providerID: str,
					/** The slot to land on, which is what a drag or a stepper names. */
					to: num,
				},
				["providerID", "alias"],
			),
			output: result,
		},
		priority: {
			input: empty,
			output: object(
				{
					entries: {
						items: object(
							{
								/** The credential's own name within the provider. */
								alias: str,
								enabled: bool,
								freeOnly: bool,
								/** The provider's display name. */
								name: str,
								position: num,
								providerID: str,
							},
							[
								"providerID",
								"alias",
								"position",
								"enabled",
								"freeOnly",
								"name",
							],
						),
						type: "array",
					},
				},
				["entries"],
			),
		},
		rebalance: {
			input: empty,
			// Whether the periodic re-check runs at all, the length it waits
			// between checks as the user typed it (empty means the built-in), and
			// when a row next checks the head of its order (ms; 0 when nothing is
			// counting down).
			output: object({ auto: bool, nextAt: num, value: str }, [
				"auto",
				"nextAt",
				"value",
			]),
		},
		setAssumeWindows: {
			input: object({ enabled: bool, providerID: str }, [
				"providerID",
				"enabled",
			]),
			output: result,
		},
		setBalancing: {
			input: object({ enabled: bool }, ["enabled"]),
			output: result,
		},
		setBufferEnforce: {
			input: object({ value: str }, ["value"]),
			output: result,
		},
		setContextBuffer: {
			input: object({ value: str }, ["value"]),
			output: result,
		},
		setContextLimit: {
			input: object({ value: str }, ["value"]),
			output: result,
		},
		setEnabled: {
			input: object({ alias: str, enabled: bool, providerID: str }, [
				"providerID",
				"alias",
				"enabled",
			]),
			output: result,
		},
		setFreeOnly: {
			input: object({ alias: str, enabled: bool, providerID: str }, [
				"providerID",
				"alias",
				"enabled",
			]),
			output: result,
		},
		setModelLimit: {
			input: object({ key: str, value: str }, ["key", "value"]),
			output: result,
		},
		setRebalance: {
			input: object({ value: str }, ["value"]),
			output: result,
		},
		setRebalanceAuto: {
			input: object({ enabled: bool }, ["enabled"]),
			output: result,
		},
		status: {
			input: empty,
			output: object(
				{
					accounts: num,
					balancing: bool,
					limited: num,
					providers: num,
				},
				["balancing", "accounts", "providers", "limited"],
			),
		},
		use: { input: pair, output: result },
	},
} satisfies Rpc.PortableDefinition;

export const Balancer = Rpc.define(balancerDefinition);
