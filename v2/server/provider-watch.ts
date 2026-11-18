type SyncEvent = { type: string };

/** Why a sync is running: a key changed, or the provider landscape did. */
export type SyncTrigger = "credential" | "provider";

export type WatchOptions = {
	/**
	 * Runs the account sync. The trigger is passed so a caller can tell a key
	 * change from a provider inventory change when it decides what to rebuild.
	 */
	sync: (trigger: SyncTrigger) => Promise<void>;
	/** Quells provider events this close to a refresh we caused ourselves. */
	cooldownMs?: number;
	/** Collects provider events that arrive together into one sync. */
	debounceMs?: number;
	onError?: (error: unknown) => void;
};

const CREDENTIAL_TYPES = new Set(["credential.updated", "credential.switched"]);
const PROVIDER_TYPES = new Set(["provider.updated", "config.updated"]);

/**
 * Keep the account store and declared models in step with OpenCode while it
 * runs. Credentials sync at once, because a freshly connected key should serve
 * the next request. Provider and config changes are debounced and then ignored
 * for a moment around our own refresh: `provider.reload()` makes the host emit
 * `provider.updated` again, and following that echo would refresh forever.
 */
export async function watchProviderChanges(
	events: AsyncIterable<SyncEvent>,
	{ sync, cooldownMs = 2000, debounceMs = 600, onError }: WatchOptions,
): Promise<void> {
	let running = false;
	let queuedCredential = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let quietUntil = 0;

	const run = async (trigger: SyncTrigger) => {
		if (running) {
			// A key connected while a refresh is in flight still needs its sync.
			if (trigger === "credential") queuedCredential = true;
			return;
		}
		running = true;
		// Set first: the refresh inside `sync` is what emits the echo.
		quietUntil = Date.now() + cooldownMs;
		try {
			await sync(trigger);
		} catch (error) {
			onError?.(error);
		} finally {
			running = false;
			if (queuedCredential) {
				queuedCredential = false;
				void run("credential");
			}
		}
	};

	const schedule = () => {
		if (Date.now() < quietUntil) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void run("provider");
		}, debounceMs);
	};

	for await (const event of events) {
		if (CREDENTIAL_TYPES.has(event.type)) {
			// A connected key is used right away; no debounce stands in for it.
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			await run("credential");
			continue;
		}
		if (PROVIDER_TYPES.has(event.type)) schedule();
	}
	if (timer) clearTimeout(timer);
}
