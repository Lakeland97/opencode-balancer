import { Plugin } from "@opencode/plugin";
import { migrateModelPercent } from "./core/context";
import { openBalancerDatabase } from "./core/database";
import { storePath } from "./core/path";
import { migrateProviderSettings } from "./core/priority";
import { migrate } from "./core/schema";
import { runCommand } from "./server/commands";
import { registerCompaction } from "./server/compaction";
import {
	invalidateCatalog,
	refreshBalancerProvider,
	registerBalancerProvider,
} from "./server/connectors";
import { registerHooks } from "./server/hooks";
import { syncAccounts } from "./server/import-credentials";
import { recordLog } from "./server/log";
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

		// The balancer keeps its own copy of every credential OpenCode holds, so
		// nothing has to be added here by hand. Import before the provider is
		// registered, because the registration reads the accounts.
		await syncAccounts(ctx, db);
		// Fold any provider-level switches left by an earlier version onto the
		// credentials they now belong to, once the credentials are all here.
		migrateProviderSettings(db);
		// A row's share was once stored per credential as well as per model; it
		// belongs to the model, so fold anything left behind onto it.
		migrateModelPercent(db);

		await registerHooks({ ctx, db });
		const rpc = await registerBalancerRpc({ ctx, db });
		await registerBalancerProvider({ ctx, db });
		// Watch the conversation ourselves: every model is declared at 1M, so
		// the host will not trim on its own and the threshold is ours to hold.
		await registerCompaction({ ctx, db });
		const openGui = async () => {
			await rpc.events.emit("open", {});
		};

		// Keep up with credentials added, removed, or switched while OpenCode is
		// running. A sync that changes something rebuilds the provider, so a key
		// connected mid-session can start serving without a restart.
		const resync = async () => {
			const result = await syncAccounts(ctx, db);
			if (result.imported > 0 || result.pruned > 0) {
				invalidateCatalog();
				await refreshBalancerProvider({ ctx, db });
			}
		};
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({
					types: ["credential.updated", "credential.switched"],
				})) {
					if (
						event.type !== "credential.updated" &&
						event.type !== "credential.switched"
					) {
						continue;
					}
					try {
						await resync();
					} catch (error) {
						recordLog(
							"error",
							`credential sync failed: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
			} catch {
				// The event stream ended; imports still happen at startup.
			}
		})();

		await ctx.command.transform((editor) => {
			editor.add({
				description:
					"Manage balancer accounts, provider priority, and automatic failover.",
				execute: async ({ prompt }) => {
					const text = await runCommand({
						ctx,
						db,
						openGui,
						raw: prompt.text,
					});
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
						openGui,
						raw: String((input as { command?: unknown }).command ?? ""),
					}),
				}),
				input: COMMAND_INPUT,
				name: "balancer_command",
			});
		});
	},
});
