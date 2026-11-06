import { Plugin } from "@opencode/plugin";
import { openBalancerDatabase } from "./core/database";
import { storePath } from "./core/path";
import { migrate } from "./core/schema";
import { runCommand } from "./server/commands";
import { registerHooks } from "./server/hooks";
import { registerBalancerRpc } from "./server/rpc";

const COMMAND_INPUT = {
	additionalProperties: false,
	properties: {
		command: {
			description: "Command arguments for /balancer.",
			type: "string",
		},
	},
	required: ["command"],
	type: "object",
} as const;

/**
 * V2 port of @thelioo/opencode-balancer.
 *
 * The published package targets the V1 plugin API, which OpenCode 2 no longer
 * loads. This port keeps the account store and priority logic unchanged and
 * re-implements the server integration on the V2 hook surface:
 *
 *   - `http.request`  selects a healthy account and injects its credential
 *   - `http.response` parks an account on a retryable status
 *   - `retry`         forces a retry when another account is available
 *
 * The terminal dashboard is replaced by the `/balancer` command, because
 * OpenCode Desktop does not render TUI plugin parts.
 */
export default Plugin.define({
	id: "balancer",
	async setup(ctx) {
		const db = openBalancerDatabase(storePath());
		migrate(db);

		await registerHooks({ ctx, db });
		await registerBalancerRpc({ ctx, db });

		await ctx.command.transform((editor) => {
			editor.add({
				description:
					"Manage balancer accounts, provider priority, and automatic failover.",
				execute: async ({ prompt }) => {
					const text = await runCommand({ ctx, db, raw: prompt.text });
					// Desktop does not render synthetic messages, so a synthetic
					// reply is invisible to the user. Throwing carries the text to
					// the client and also stops the command from becoming a model
					// prompt. Same approach as the upstream V1 plugin.
					throw new Error(`[balancer]\n${text}`);
				},
				name: "balancer",
			});
		});

		await ctx.tool.transform((editor) => {
			editor.add({
				description: "Run balancer account and failover commands.",
				execute: async (input) => ({
					content: await runCommand({
						ctx,
						db,
						raw: String((input as { command?: unknown }).command ?? ""),
					}),
				}),
				input: COMMAND_INPUT,
				name: "balancer_command",
			});
		});
	},
});
