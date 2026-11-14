import type { Database } from "bun:sqlite";
import { now } from "./time";
import type { Account, AuthInfo, SelectedModel } from "./types";

type AccountRow = {
	provider_id: string;
	alias: string;
	auth_json: string;
	auth_type: string;
	created_at: number;
	updated_at: number;
	last_used_at: number | null;
	rate_limited_until: number | null;
	failures: number;
	disabled: number;
	source_id: string | null;
	position: number;
	free_only: number;
};

const authTypes = ["api", "oauth", "wellknown"] as const;

export type UsedAccount = { providerID: string; alias: string; at: number };

/**
 * Record that an account is the one the router is pointed at now, which is
 * what "in use" reads. Being tried also clears the park left by its last
 * failure: "limited" then means "failed and not yet retried", and lasts until
 * the chain wraps back around to it, not until a clock runs out.
 */
export function markAccountUsed(
	db: Database,
	providerID: string,
	alias: string,
	at: number = now(),
) {
	db.query<unknown, [number, string, string]>(
		"UPDATE accounts SET last_used_at = ?, rate_limited_until = NULL WHERE provider_id = ? AND alias = ?",
	).run(at, providerID, alias);
	clearLimitedReason(db, providerID, alias);
}

/**
 * Take the park off an account without pretending it has served anything.
 * Picking an account to use is itself an attempt at it, so it is what "limited"
 * has been waiting for: the user asking for this account again is how a
 * cooldown is tested, and it must not leave the row looking untouched.
 */
export function clearAccountPark(
	db: Database,
	providerID: string,
	alias: string,
) {
	db.query<unknown, [string, string]>(
		"UPDATE accounts SET rate_limited_until = NULL WHERE provider_id = ? AND alias = ?",
	).run(providerID, alias);
	clearLimitedReason(db, providerID, alias);
}

/** Where the reason an account was parked is kept, next to the other settings. */
function limitedReasonKey(providerID: string, alias: string) {
	return `limited_reason:${providerID}:${alias}`;
}

/**
 * Remember what the endpoint actually said when it parked the account, so the
 * panel can answer "limited because of what?" on hover instead of asserting a
 * state with no evidence beside it.
 */
export function setLimitedReason(
	db: Database,
	providerID: string,
	alias: string,
	reason: string,
) {
	db.query<unknown, [string, string]>(
		`INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(limitedReasonKey(providerID, alias), reason.slice(0, 300));
}

export function readLimitedReason(
	db: Database,
	providerID: string,
	alias: string,
): string | undefined {
	const row = db
		.query<{ value: string }, [string]>(
			"SELECT value FROM settings WHERE key = ?",
		)
		.get(limitedReasonKey(providerID, alias));
	return row?.value;
}

export function clearLimitedReason(
	db: Database,
	providerID: string,
	alias: string,
) {
	db.query<unknown, [string]>("DELETE FROM settings WHERE key = ?").run(
		limitedReasonKey(providerID, alias),
	);
}

/**
 * The single account that served the most recent request anywhere. The panel
 * shows exactly one account as "in use", so this is provider-independent.
 */
export function mostRecentlyUsed(
	db: Database,
): { providerID: string; alias: string; at: number } | undefined {
	const row = db
		.query<{ provider_id: string; alias: string; last_used_at: number }, []>(
			`SELECT provider_id, alias, last_used_at FROM accounts
             WHERE last_used_at IS NOT NULL
             ORDER BY last_used_at DESC LIMIT 1`,
		)
		.get();
	return row
		? { alias: row.alias, at: row.last_used_at, providerID: row.provider_id }
		: undefined;
}

export function normalizeAlias(alias: string) {
	return alias
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function accountRowID(row: AccountRow) {
	return `${row.provider_id}/${row.alias}`;
}

function isAuthType(value: string): value is AuthInfo["type"] {
	return authTypes.includes(value as AuthInfo["type"]);
}

function parseAccountAuth(row: AccountRow): AuthInfo {
	const id = accountRowID(row);
	let auth: unknown;
	try {
		auth = JSON.parse(row.auth_json);
	} catch {
		throw new Error(`Invalid account row for ${id}: auth_json is invalid`);
	}

	if (
		!auth ||
		typeof auth !== "object" ||
		!("type" in auth) ||
		typeof auth.type !== "string"
	) {
		throw new Error(`Invalid account row for ${id}: auth_json type is invalid`);
	}
	if (!isAuthType(auth.type)) {
		throw new Error(
			`Invalid account row for ${id}: auth_json type ${auth.type} is invalid`,
		);
	}
	return auth as AuthInfo;
}

function validateAccountAuthType(row: AccountRow): AuthInfo["type"] {
	if (!isAuthType(row.auth_type)) {
		throw new Error(
			`Invalid account row for ${accountRowID(row)}: auth_type ${row.auth_type} is invalid`,
		);
	}
	return row.auth_type;
}

function validateDisabled(row: AccountRow) {
	if (row.disabled !== 0 && row.disabled !== 1) {
		throw new Error(
			`Invalid account row for ${accountRowID(row)}: disabled ${row.disabled} is invalid`,
		);
	}
	return Boolean(row.disabled);
}

function validateFlag(row: AccountRow, column: "free_only") {
	if (row[column] !== 0 && row[column] !== 1) {
		throw new Error(
			`Invalid account row for ${accountRowID(row)}: ${column} ${row[column]} is invalid`,
		);
	}
	return Boolean(row[column]);
}

function validatePosition(row: AccountRow) {
	if (!Number.isInteger(row.position) || row.position < 0) {
		throw new Error(
			`Invalid account row for ${accountRowID(row)}: position ${row.position} is invalid`,
		);
	}
	return row.position;
}

function accountFromRow(row: AccountRow): Account {
	const auth = parseAccountAuth(row);
	const authType = validateAccountAuthType(row);
	if (auth.type !== authType) {
		throw new Error(
			`Invalid account row for ${accountRowID(row)}: auth_type ${authType} does not match auth_json type ${auth.type}`,
		);
	}

	return {
		alias: row.alias,
		auth,
		authType,
		createdAt: row.created_at,
		disabled: validateDisabled(row),
		failures: row.failures,
		freeOnly: validateFlag(row, "free_only"),
		lastUsedAt: row.last_used_at ?? undefined,
		position: validatePosition(row),
		providerID: row.provider_id,
		rateLimitedUntil: row.rate_limited_until ?? undefined,
		sourceID: row.source_id ?? undefined,
		updatedAt: row.updated_at,
	};
}

function setActiveAlias(db: Database, providerID: string, alias: string) {
	db.query<unknown, [string, string, number]>(
		`INSERT INTO provider_state (provider_id, active_alias, updated_at, metadata_json)
         VALUES (?, ?, ?, '{}')
         ON CONFLICT(provider_id) DO UPDATE SET
             active_alias = excluded.active_alias,
             updated_at = excluded.updated_at`,
	).run(providerID, alias, now());
	db.query<unknown, [string]>(
		`INSERT INTO settings (key, value) VALUES ('selected_provider_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(providerID);
}

function parseMetadataJson(
	value: string | null | undefined,
): Record<string, unknown> {
	if (!value) return {};
	try {
		const metadata = JSON.parse(value);
		return metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? metadata
			: {};
	} catch {
		return {};
	}
}

export function saveAccount(
	db: Database,
	providerID: string,
	aliasInput: string,
	auth: AuthInfo,
): Account {
	const alias = normalizeAlias(aliasInput);
	if (!alias) throw new Error("Invalid alias");

	const save = db.transaction(() => {
		const timestamp = now();
		db.query<
			unknown,
			[string, string, string, string, number, number, number, number]
		>(
			`INSERT INTO accounts (
                 provider_id,
                 alias,
                 auth_json,
                 auth_type,
                 created_at,
                 updated_at,
                 failures,
                 disabled,
                 position
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM accounts))
             ON CONFLICT(provider_id, alias) DO UPDATE SET
                 auth_json = excluded.auth_json,
                 auth_type = excluded.auth_type,
                 updated_at = excluded.updated_at`,
		).run(
			providerID,
			alias,
			JSON.stringify(auth),
			auth.type,
			timestamp,
			timestamp,
			0,
			0,
		);
		setActiveAlias(db, providerID, alias);

		const account = getAccount(db, providerID, alias);
		if (!account) throw new Error(`Account not found: ${providerID}/${alias}`);
		return account;
	});

	return save();
}

export function updateAccountAuth(
	db: Database,
	providerID: string,
	aliasInput: string,
	auth: AuthInfo,
): Account | undefined {
	const alias = normalizeAlias(aliasInput);
	if (!alias) throw new Error("Invalid alias");

	db.query<unknown, [string, string, number, string, string]>(
		`UPDATE accounts
         SET auth_json = ?,
             auth_type = ?,
             updated_at = ?
         WHERE provider_id = ? AND alias = ?`,
	).run(JSON.stringify(auth), auth.type, now(), providerID, alias);
	return getAccount(db, providerID, alias);
}

export function renameAccount(
	db: Database,
	providerID: string,
	fromAliasInput: string,
	toAliasInput: string,
): Account {
	const fromAlias = normalizeAlias(fromAliasInput);
	const toAlias = normalizeAlias(toAliasInput);
	if (!fromAlias || !toAlias) throw new Error("Invalid alias");
	if (fromAlias === toAlias) {
		const account = getAccount(db, providerID, fromAlias);
		if (!account)
			throw new Error(`Account not found: ${providerID}/${fromAlias}`);
		return account;
	}

	const rename = db.transaction(() => {
		const existing = getAccount(db, providerID, fromAlias);
		if (!existing)
			throw new Error(`Account not found: ${providerID}/${fromAlias}`);
		if (getAccount(db, providerID, toAlias))
			throw new Error(`Account already exists: ${providerID}/${toAlias}`);

		db.query<unknown, [string, number, string, string]>(
			`UPDATE accounts
             SET alias = ?, updated_at = ?
             WHERE provider_id = ? AND alias = ?`,
		).run(toAlias, now(), providerID, fromAlias);
		db.query<unknown, [string, string, string]>(
			`UPDATE usage_snapshots
             SET alias = ?
             WHERE provider_id = ? AND alias = ?`,
		).run(toAlias, providerID, fromAlias);

		const active = db
			.query<{ active_alias: string | null }, [string]>(
				"SELECT active_alias FROM provider_state WHERE provider_id = ?",
			)
			.get(providerID);
		if (active?.active_alias === fromAlias)
			setActiveAlias(db, providerID, toAlias);

		const account = getAccount(db, providerID, toAlias);
		if (!account)
			throw new Error(`Account not found: ${providerID}/${toAlias}`);
		return account;
	});

	return rename();
}

export function getAccount(
	db: Database,
	providerID: string,
	alias: string,
): Account | undefined {
	const normalizedAlias = normalizeAlias(alias);
	const row = db
		.query<AccountRow, [string, string]>(
			`SELECT provider_id, alias, auth_json, auth_type, created_at, updated_at,
                    last_used_at, rate_limited_until, failures, disabled, source_id, position, free_only
             FROM accounts
             WHERE provider_id = ? AND alias = ?`,
		)
		.get(providerID, normalizedAlias);
	return row ? accountFromRow(row) : undefined;
}

export function listAccounts(db: Database, providerID?: string): Account[] {
	const sql = `SELECT provider_id, alias, auth_json, auth_type, created_at, updated_at,
                        last_used_at, rate_limited_until, failures, disabled, source_id, position, free_only
                 FROM accounts`;
	const rows = providerID
		? db
				.query<AccountRow, [string]>(
					`${sql} WHERE provider_id = ? ORDER BY alias`,
				)
				.all(providerID)
		: db.query<AccountRow, []>(`${sql} ORDER BY provider_id, alias`).all();
	return rows.map(accountFromRow);
}

/**
 * Every account in the balancer's order, which is what the panel lists and the
 * router walks. Credentials are the unit, so the order spans providers: a
 * provider's place is where its earliest credential sits. `moveAccount` writes
 * positions densely, and a tie falls back to provider and alias so the order is
 * never ambiguous.
 */
export function orderedAccounts(db: Database, providerID?: string): Account[] {
	return listAccounts(db, providerID).sort((a, b) => {
		if (a.position !== b.position) return a.position - b.position;
		const provider = a.providerID.localeCompare(b.providerID);
		return provider === 0 ? a.alias.localeCompare(b.alias) : provider;
	});
}

/** Switch a credential on or off; `disabled` is what the health check reads. */
export function setAccountEnabled(
	db: Database,
	providerID: string,
	alias: string,
	enabled: boolean,
) {
	db.query<unknown, [number, number, string, string]>(
		`UPDATE accounts SET disabled = ?, updated_at = ?
         WHERE provider_id = ? AND alias = ?`,
	).run(enabled ? 0 : 1, now(), providerID, normalizeAlias(alias));
}

/** Whether this credential may only be sent models that cost nothing. */
export function setAccountFreeOnly(
	db: Database,
	providerID: string,
	alias: string,
	freeOnly: boolean,
) {
	db.query<unknown, [number, number, string, string]>(
		`UPDATE accounts SET free_only = ?, updated_at = ?
         WHERE provider_id = ? AND alias = ?`,
	).run(freeOnly ? 1 : 0, now(), providerID, normalizeAlias(alias));
}

/**
 * Move one credential a step through the order, swapping it with the row it
 * passes and renumbering densely, so a later move always has a neighbour to
 * trade places with.
 */
export function moveAccount(
	db: Database,
	providerID: string,
	alias: string,
	delta: number,
) {
	const all = orderedAccounts(db);
	const wanted = normalizeAlias(alias);
	const from = all.findIndex(
		(account) => account.providerID === providerID && account.alias === wanted,
	);
	if (from < 0) return;
	const to = from + delta;
	if (to < 0 || to >= all.length) return;

	const reordered = all.slice();
	const [moved] = reordered.splice(from, 1);
	reordered.splice(to, 0, moved);

	const write = db.transaction(() => {
		for (const [position, account] of reordered.entries()) {
			db.query<unknown, [number, number, string, string]>(
				`UPDATE accounts SET position = ?, updated_at = ?
                 WHERE provider_id = ? AND alias = ?`,
			).run(position, now(), account.providerID, account.alias);
		}
	});
	write();
}

export function setActiveAccount(
	db: Database,
	providerID: string,
	alias: string,
): Account {
	const normalizedAlias = normalizeAlias(alias);
	const account = getAccount(db, providerID, normalizedAlias);
	if (!account)
		throw new Error(`Account not found: ${providerID}/${normalizedAlias}`);

	setActiveAlias(db, providerID, normalizedAlias);
	return account;
}

export function removeAccount(db: Database, providerID: string, alias: string) {
	const normalizedAlias = normalizeAlias(alias);
	const remove = db.transaction(() => {
		const existing = getAccount(db, providerID, normalizedAlias);
		if (!existing) return false;

		db.query<unknown, [string, string]>(
			"DELETE FROM accounts WHERE provider_id = ? AND alias = ?",
		).run(providerID, normalizedAlias);
		db.query<unknown, [string, string]>(
			"DELETE FROM usage_snapshots WHERE provider_id = ? AND alias = ?",
		).run(providerID, normalizedAlias);

		const active = db
			.query<{ active_alias: string | null }, [string]>(
				"SELECT active_alias FROM provider_state WHERE provider_id = ?",
			)
			.get(providerID);
		if (active?.active_alias === normalizedAlias) {
			const next = db
				.query<{ alias: string }, [string]>(
					"SELECT alias FROM accounts WHERE provider_id = ? ORDER BY alias LIMIT 1",
				)
				.get(providerID);
			db.query<unknown, [string | null, number, string]>(
				`UPDATE provider_state
                 SET active_alias = ?, updated_at = ?
                 WHERE provider_id = ?`,
			).run(next?.alias ?? null, now(), providerID);
		}

		return true;
	});

	return remove();
}

export function getActiveAccount(
	db: Database,
	providerID: string,
): Account | undefined {
	const row = db
		.query<{ active_alias: string | null }, [string]>(
			"SELECT active_alias FROM provider_state WHERE provider_id = ?",
		)
		.get(providerID);
	if (!row?.active_alias) return undefined;
	return getAccount(db, providerID, row.active_alias);
}

export function getSelectedAccount(db: Database): Account | undefined {
	const selectedProvider = db
		.query<{ value: string }, []>(
			"SELECT value FROM settings WHERE key = 'selected_provider_id'",
		)
		.get();
	if (selectedProvider?.value) {
		const active = getActiveAccount(db, selectedProvider.value);
		if (active) return active;
	}

	const row = db
		.query<{ provider_id: string; active_alias: string }, []>(
			`SELECT provider_id, active_alias
             FROM provider_state
             WHERE active_alias IS NOT NULL
             ORDER BY updated_at DESC, provider_id
             LIMIT 1`,
		)
		.get();
	if (!row?.active_alias) return undefined;
	return getAccount(db, row.provider_id, row.active_alias);
}

export function setSelectedModel(
	db: Database,
	providerID: string,
	modelID: string,
): SelectedModel {
	const row = db
		.query<{ metadata_json: string | null }, [string]>(
			"SELECT metadata_json FROM provider_state WHERE provider_id = ?",
		)
		.get(providerID);
	const metadata = parseMetadataJson(row?.metadata_json);
	metadata.selected_model_id = modelID;

	db.query<unknown, [string, number, string]>(
		`INSERT INTO provider_state (provider_id, active_alias, updated_at, metadata_json)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             metadata_json = excluded.metadata_json`,
	).run(providerID, now(), JSON.stringify(metadata));

	return { modelID, providerID };
}

export function getSelectedModel(
	db: Database,
	providerID: string,
): SelectedModel | undefined {
	const row = db
		.query<{ metadata_json: string | null }, [string]>(
			"SELECT metadata_json FROM provider_state WHERE provider_id = ?",
		)
		.get(providerID);
	const modelID = parseMetadataJson(row?.metadata_json).selected_model_id;
	if (typeof modelID !== "string" || modelID.length === 0) return undefined;
	return { modelID, providerID };
}

function findBySourceID(
	db: Database,
	providerID: string,
	sourceID: string,
): Account | undefined {
	const row = db
		.query<AccountRow, [string, string]>(
			`SELECT provider_id, alias, auth_json, auth_type, created_at, updated_at,
                    last_used_at, rate_limited_until, failures, disabled, source_id, position, free_only
             FROM accounts
             WHERE provider_id = ? AND source_id = ?`,
		)
		.get(providerID, sourceID);
	return row ? accountFromRow(row) : undefined;
}

/**
 * The account a host credential was imported as, if it is still here.
 */
export function getAccountBySourceID(
	db: Database,
	providerID: string,
	sourceID: string,
): Account | undefined {
	return findBySourceID(db, providerID, sourceID);
}

/** A free alias for a new account, numbering a collision rather than merging. */
function uniqueAlias(db: Database, providerID: string, base: string): string {
	const taken = new Set(
		listAccounts(db, providerID).map((account) => account.alias),
	);
	if (!taken.has(base)) return base;
	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) suffix += 1;
	return `${base}-${suffix}`;
}

/**
 * The credential's own name is the alias here, so everything that was keyed by
 * the alias — the park's reason, the usage history, the provider's selection —
 * has to follow it.
 */
function moveAlias(
	db: Database,
	providerID: string,
	fromAlias: string,
	toAlias: string,
) {
	db.query<unknown, [string, string, string]>(
		"UPDATE accounts SET alias = ? WHERE provider_id = ? AND alias = ?",
	).run(toAlias, providerID, fromAlias);
	db.query<unknown, [string, string, string]>(
		"UPDATE usage_snapshots SET alias = ? WHERE provider_id = ? AND alias = ?",
	).run(toAlias, providerID, fromAlias);

	const active = db
		.query<{ active_alias: string | null }, [string]>(
			"SELECT active_alias FROM provider_state WHERE provider_id = ?",
		)
		.get(providerID);
	if (active?.active_alias === fromAlias)
		setActiveAlias(db, providerID, toAlias);

	const reason = readLimitedReason(db, providerID, fromAlias);
	if (reason !== undefined) {
		clearLimitedReason(db, providerID, fromAlias);
		setLimitedReason(db, providerID, toAlias, reason);
	}
}

/**
 * Copy a credential OpenCode holds into the balancer's own store. The host is
 * the source of truth: re-importing a credential refreshes its key and follows
 * a rename in OpenCode, but leaves everything the balancer itself tracks — the
 * last use, a park, a failure count — exactly as it was found.
 */
export function importAccount(
	db: Database,
	input: {
		auth: AuthInfo;
		label: string;
		providerID: string;
		sourceID: string;
	},
): Account {
	const { providerID } = input;
	const save = db.transaction(() => {
		const timestamp = now();
		const existing = findBySourceID(db, providerID, input.sourceID);
		const wanted =
			normalizeAlias(input.label) ||
			`credential-${normalizeAlias(input.sourceID)}`;

		let alias: string;
		if (existing) {
			// Follow OpenCode's rename, but never take a name another account
			// already answers to.
			alias =
				wanted !== existing.alias && !getAccount(db, providerID, wanted)
					? wanted
					: existing.alias;
			if (alias !== existing.alias)
				moveAlias(db, providerID, existing.alias, alias);
		} else {
			alias = uniqueAlias(db, providerID, wanted);
		}

		db.query<unknown, [string, string, string, string, number, number, string]>(
			`INSERT INTO accounts (
                 provider_id,
                 alias,
                 auth_json,
                 auth_type,
                 created_at,
                 updated_at,
                 failures,
                 disabled,
                 source_id,
                 position
             ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM accounts))
             ON CONFLICT(provider_id, alias) DO UPDATE SET
                 auth_json = excluded.auth_json,
                 auth_type = excluded.auth_type,
                 updated_at = excluded.updated_at,
                 source_id = excluded.source_id`,
		).run(
			providerID,
			alias,
			JSON.stringify(input.auth),
			input.auth.type,
			timestamp,
			timestamp,
			input.sourceID,
		);

		const account = getAccount(db, providerID, alias);
		if (!account) throw new Error(`Account not found: ${providerID}/${alias}`);
		return account;
	});

	return save();
}

/**
 * Drop every account whose credential OpenCode no longer lists. Entries added
 * by hand have no credential behind them, so they go the same way: the host is
 * the one place keys are managed.
 */
export function pruneImportedAccounts(
	db: Database,
	keepSourceIDs: string[],
): number {
	const keep = new Set(keepSourceIDs);
	const rows = db
		.query<
			{ provider_id: string; alias: string; source_id: string | null },
			[]
		>("SELECT provider_id, alias, source_id FROM accounts")
		.all();

	let removed = 0;
	for (const row of rows) {
		if (row.source_id && keep.has(row.source_id)) continue;
		if (removeAccount(db, row.provider_id, row.alias)) removed += 1;
	}
	return removed;
}

/**
 * Point a provider at the credential OpenCode calls active, but only when the
 * balancer has no selection of its own left. A live selection is the user's
 * choice and survives a sync.
 */
export function ensureActiveAlias(
	db: Database,
	providerID: string,
	alias: string,
) {
	if (getActiveAccount(db, providerID)) return;
	if (!getAccount(db, providerID, alias)) return;
	setActiveAccount(db, providerID, alias);
}
