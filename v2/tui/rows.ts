import { credentialNote, formatAgo, servingText } from "../core/format";
import { groupByBrand } from "../core/models";
import type { Account, Chain, InUseEntry, Provider } from "../types";

/**
 * One row that is being served right now, as the panel says it.
 *
 * The model shown is the connector's own id, not the row label: a routed row is
 * a name this plugin invented and the provider never sees it, so the label
 * would tell the user nothing about what was actually called. The level is the
 * one the connector applied; a request that asked for a different one is worth
 * saying out loud rather than dropping, so it rides in `note` beside the line.
 */
export function servingLine(entry: InUseEntry, now: number = Date.now()) {
	const ago = formatAgo(entry.at, now);
	const text = ago ? `${servingText(entry)} · ${ago}` : servingText(entry);
	const note =
		entry.variant && entry.variant !== entry.applied
			? entry.applied
				? `asked ${entry.variant}, applied ${entry.applied}`
				: `asked ${entry.variant}`
			: "";
	return { note, text };
}

/**
 * The providers section is one row per credential, in the balancer's order:
 * the order, the switches and the grip all act on the credential, so nothing
 * rides a provider header row.
 */
export function providerEntries(accounts: Account[], providers: Provider[]) {
	return providers.map((entry) => ({
		account: accounts.find(
			(account) =>
				account.providerID === entry.providerID &&
				account.alias === entry.alias,
		),
		entry,
	}));
}

/**
 * The panel lists rows that actually triage between providers, plus any row the
 * user built by hand. Everything else is noise.
 *
 * Multi-provider rows and hand-built ones, read alphabetically: the catalogue
 * order is whatever the connectors happened to report.
 */
export function visibleChains(chains: Chain[]) {
	return chains
		.filter((chain) => chain.stored || chain.targets.length > 1)
		.sort((a, b) =>
			a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
		);
}

/**
 * Rows gather under the brand their label starts with, so Claude and DeepSeek
 * rows sit together instead of interleaving alphabetically.
 */
export function groupedChains(chains: Chain[]) {
	return groupByBrand(visibleChains(chains));
}

/**
 * Collapse all flips the whole list at once. The models section counts as one of
 * those headers: leaving it out made "collapse all" stop one fold short of
 * everything.
 */
export function allCollapsed(input: {
	collapsed: Record<string, boolean>;
	chains: Chain[];
	groups: Record<string, boolean>;
	modelsOpen: boolean;
}) {
	return (
		!input.modelsOpen &&
		visibleChains(input.chains).every(
			(chain) => input.collapsed[chain.key] !== false,
		)
	);
}

/**
 * What a credential's control line says, left of the switches: the refill the
 * endpoint named and the provider's own words when it refused. The marker above
 * clears on the next attempt, so this reports the last attempt rather than
 * predicting the next one.
 */
export function rowNote(
	account: Account | undefined,
	resets: string,
	now?: number,
) {
	// A park with no words, or words with no time in them, has nothing to say,
	// so the refill stays undefined rather than inventing a moment.
	const rollover =
		account?.limited && account.limitedUntil > 0
			? account.limitedUntil
			: undefined;
	return credentialNote({
		limited: Boolean(account?.limited),
		limitedUntil: rollover,
		now,
		reason: account?.limitedReason,
		resets,
	});
}
