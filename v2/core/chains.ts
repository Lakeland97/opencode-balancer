import type { Database } from "bun:sqlite";
import { now } from "./time";

export type ChainTarget = {
	providerID: string;
	modelID: string;
	baseURL: string;
};

export type StoredChain = {
	familyKey: string;
	label: string;
	package: string;
	targets: ChainTarget[];
};

type ChainRow = { family_key: string; label: string; package: string };

type TargetRow = {
	family_key: string;
	position: number;
	provider_id: string;
	model_id: string;
	base_url: string;
};

function readTargets(db: Database, familyKey: string): ChainTarget[] {
	return db
		.query<TargetRow, [string]>(
			`SELECT family_key, position, provider_id, model_id, base_url
             FROM model_chain_targets
             WHERE family_key = ?
             ORDER BY position`,
		)
		.all(familyKey)
		.map((row) => ({
			baseURL: row.base_url,
			modelID: row.model_id,
			providerID: row.provider_id,
		}));
}

/** The stored chain for a row, or undefined when the row is still automatic. */
export function getStoredChain(
	db: Database,
	familyKey: string,
): StoredChain | undefined {
	const row = db
		.query<ChainRow, [string]>(
			"SELECT family_key, label, package FROM model_chains WHERE family_key = ?",
		)
		.get(familyKey);
	if (!row) return undefined;
	return {
		familyKey: row.family_key,
		label: row.label,
		package: row.package,
		targets: readTargets(db, familyKey),
	};
}

export function listStoredChains(db: Database): StoredChain[] {
	const chains = db
		.query<ChainRow, []>(
			"SELECT family_key, label, package FROM model_chains ORDER BY family_key",
		)
		.all();
	const targets = db
		.query<TargetRow, []>(
			`SELECT family_key, position, provider_id, model_id, base_url
             FROM model_chain_targets
             ORDER BY family_key, position`,
		)
		.all();

	const byKey = new Map<string, ChainTarget[]>();
	for (const row of targets) {
		const list = byKey.get(row.family_key) ?? [];
		list.push({
			baseURL: row.base_url,
			modelID: row.model_id,
			providerID: row.provider_id,
		});
		byKey.set(row.family_key, list);
	}

	return chains.map((row) => ({
		familyKey: row.family_key,
		label: row.label,
		package: row.package,
		targets: byKey.get(row.family_key) ?? [],
	}));
}

/**
 * Replaces a row's chain. An empty target list clears the stored chain, which
 * hands the row back to automatic routing.
 */
export function saveChain(
	db: Database,
	chain: {
		familyKey: string;
		label: string;
		package: string;
		targets: readonly ChainTarget[];
	},
) {
	if (chain.targets.length === 0) {
		deleteChain(db, chain.familyKey);
		return;
	}

	const write = db.transaction(() => {
		db.query<unknown, [string, string, string, number]>(
			`INSERT INTO model_chains (family_key, label, package, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(family_key) DO UPDATE SET
                 label = excluded.label,
                 package = excluded.package,
                 updated_at = excluded.updated_at`,
		).run(chain.familyKey, chain.label, chain.package, now());

		db.query<unknown, [string]>(
			"DELETE FROM model_chain_targets WHERE family_key = ?",
		).run(chain.familyKey);

		const insert = db.query<unknown, [string, number, string, string, string]>(
			`INSERT INTO model_chain_targets
                 (family_key, position, provider_id, model_id, base_url)
             VALUES (?, ?, ?, ?, ?)`,
		);
		for (const [position, target] of chain.targets.entries()) {
			insert.run(
				chain.familyKey,
				position,
				target.providerID,
				target.modelID,
				target.baseURL,
			);
		}
	});
	write();
}

export function deleteChain(db: Database, familyKey: string): boolean {
	const remove = db.transaction(() => {
		db.query<unknown, [string]>(
			"DELETE FROM model_chain_targets WHERE family_key = ?",
		).run(familyKey);
		return db
			.query<unknown, [string]>("DELETE FROM model_chains WHERE family_key = ?")
			.run(familyKey).changes;
	});
	return Number(remove()) > 0;
}

/** Moves one target by one slot. Returns false at the edges or for unknown rows. */
export function moveTarget(
	db: Database,
	familyKey: string,
	providerID: string,
	direction: -1 | 1,
): boolean {
	const chain = getStoredChain(db, familyKey);
	if (!chain) return false;
	const index = chain.targets.findIndex(
		(target) => target.providerID === providerID,
	);
	if (index === -1) return false;
	const destination = index + direction;
	if (destination < 0 || destination >= chain.targets.length) return false;

	const reordered = chain.targets.slice();
	const [moved] = reordered.splice(index, 1);
	reordered.splice(destination, 0, moved);

	const write = db.transaction(() => {
		const insert = db.query<unknown, [number, string, string]>(
			`UPDATE model_chain_targets SET position = ?
             WHERE family_key = ? AND provider_id = ?`,
		);
		for (const [position, target] of reordered.entries()) {
			insert.run(position, familyKey, target.providerID);
		}
		db.query<unknown, [number, string]>(
			"UPDATE model_chains SET updated_at = ? WHERE family_key = ?",
		).run(now(), familyKey);
	});
	write();
	return true;
}
