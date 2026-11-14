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
		modelID: str,
		/** The user's share of this model's own window, 0 when it follows the global. */
		percent: num,
		providerID: str,
		/** The model actually sent, once a free-only provider substitutes. */
		resolved: str,
		state: str,
	},
	["providerID", "modelID", "resolved", "state", "percent"],
);
const chainRow = object(
	{
		key: str,
		label: str,
		package: str,
		stored: bool,
		targets: { items: chainTarget, type: "array" },
	},
	["key", "label", "package", "stored", "targets"],
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
			input: object({ providerID: str }, ["providerID"]),
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
					direction: { enum: ["up", "down"], type: "string" },
					key: str,
					providerID: str,
				},
				["key", "providerID", "direction"],
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
		contextPercent: {
			input: empty,
			// The share of the declared window the balancer compacts at, unless a
			// model overrides it with its own.
			output: object({ percent: num }, ["percent"]),
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
					direction: { enum: ["up", "down"], type: "string" },
					providerID: str,
				},
				["providerID", "direction"],
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
								enabled: bool,
								freeOnly: bool,
								modelID: str,
								name: str,
								position: num,
								providerID: str,
							},
							["providerID", "position", "enabled", "freeOnly", "name"],
						),
						type: "array",
					},
				},
				["entries"],
			),
		},
		setBalancing: {
			input: object({ enabled: bool }, ["enabled"]),
			output: result,
		},
		setContextPercent: {
			input: object({ value: str }, ["value"]),
			output: result,
		},
		setEnabled: {
			input: object({ enabled: bool, providerID: str }, [
				"providerID",
				"enabled",
			]),
			output: result,
		},
		setFreeOnly: {
			input: object({ enabled: bool, providerID: str }, [
				"providerID",
				"enabled",
			]),
			output: result,
		},
		setTargetPercent: {
			input: object({ key: str, providerID: str, value: str }, [
				"key",
				"providerID",
				"value",
			]),
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
