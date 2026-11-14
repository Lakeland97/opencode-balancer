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
		providerID: str,
		state: str,
	},
	["providerID", "modelID", "state"],
);
const chainRow = object(
	{
		context: num,
		declaredContext: num,
		key: str,
		label: str,
		package: str,
		stored: bool,
		targets: { items: chainTarget, type: "array" },
	},
	[
		"key",
		"label",
		"package",
		"stored",
		"context",
		"declaredContext",
		"targets",
	],
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
		providerID: str,
	},
	["providerID", "alias", "active", "disabled", "limited", "failures"],
);

/**
 * Typed surface for clients (GUI part, TUI, SDK) to manage accounts without
 * parsing command output.
 */
const definition = {
	events: {
		// Lets the server-side command surface ask an open Desktop window to
		// reveal the panel; a terminal-only session simply has no listener.
		open: { schema: empty },
	},
	id: "balancer",
	methods: {
		add: { input: pair, output: result },
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
		list: {
			input: object({ providerID: str }),
			output: object({ accounts: { items: account, type: "array" } }, [
				"accounts",
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
								modelID: str,
								name: str,
								position: num,
								providerID: str,
							},
							["providerID", "position", "enabled", "name"],
						),
						type: "array",
					},
				},
				["entries"],
			),
		},
		remove: { input: pair, output: result },
		rename: {
			input: object({ alias: str, nextAlias: str, providerID: str }, [
				"providerID",
				"alias",
				"nextAlias",
			]),
			output: result,
		},
		setBalancing: {
			input: object({ enabled: bool }, ["enabled"]),
			output: result,
		},
		setEnabled: {
			input: object({ enabled: bool, providerID: str }, [
				"providerID",
				"enabled",
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

export const Balancer = Rpc.define(definition);
