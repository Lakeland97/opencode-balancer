/**
 * Whether this machine can reach the internet at all.
 *
 * A dropped uplink is not a provider's failure. Deciding that it is parks a
 * healthy credential, walks the rest of the row, and ends with every target
 * called unavailable — which is what a router with no network would report no
 * matter which providers it holds. Before a connection failure is charged to
 * anyone, one cheap question is asked of Cloudflare's DNS-over-HTTPS endpoint:
 * can we reach the internet? Only an affirmative answer lets the failure move
 * on to the providers.
 *
 * The answer is cached briefly because a single walk can meet the same dropped
 * connection on several attempts, and each probe costs a round trip. On a real
 * outage the first probe fails and the rest reuse it; when the link returns,
 * the next probe is at most a few seconds away.
 */
const ENDPOINT = "https://1.1.1.1/dns-query?name=example.com&type=A";
const TIMEOUT_MS = 2_500;
const CACHE_MS = 10_000;

type Probe = () => Promise<boolean>;

async function cloudflare(): Promise<boolean> {
	try {
		const response = await fetch(ENDPOINT, {
			headers: { accept: "application/dns-json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}

let probe: Probe = cloudflare;
let cached: { at: number; up: boolean } | undefined;

export async function internetReachable(): Promise<boolean> {
	const at = Date.now();
	if (cached && at - cached.at < CACHE_MS) return cached.up;
	const up = await probe();
	cached = { at, up };
	return up;
}

/** Tests replace the network probe; passing nothing restores Cloudflare. */
export function setInternetProbe(next?: Probe) {
	probe = next ?? cloudflare;
	cached = undefined;
}
