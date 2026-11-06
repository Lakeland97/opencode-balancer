import { Rpc } from "@opencode/plugin/rpc";
import type { JsonSchema } from "effect";

const str: JsonSchema.JsonSchema = { type: "string" };
const bool: JsonSchema.JsonSchema = { type: "boolean" };
const num: JsonSchema.JsonSchema = { type: "number" };

function object(
	properties: Record<string, JsonSchema.JsonSchema>,
	required: string[] = [],
): JsonSchema.JsonSchema {
	return { additionalProperties: false, properties, required, type: "object" };
}

const empty = object({});
const pair = object({ alias: str, providerID: str }, ["providerID", "alias"]);
const result = object({ message: str, ok: bool }, ["ok", "message"]);
const account = object(
	{
		active: bool,
		alias: str,
		disabled: bool,
		failures: num,
		limited: bool,
		providerID: str,
	},
	["providerID", "alias", "active", "disabled", "limited", "failures"],
);

/**
 * Typed surface for clients (GUI part, TUI, SDK) to manage accounts without
 * parsing command output.
 */
export const Balancer = Rpc.define({
	events: {},
	id: "balancer",
	methods: {
		add: { input: pair, output: result },
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
								position: num,
								providerID: str,
							},
							["providerID", "position", "enabled"],
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
		setModel: {
			input: object({ modelID: str, providerID: str }, [
				"providerID",
				"modelID",
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
});
