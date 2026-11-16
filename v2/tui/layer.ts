import { copy } from "../copy";

/**
 * The panel's one command. The layer must be `global`: a layer defaults to
 * `base`, and `base` stops being reachable while the command palette pushes its
 * own mode, which hides the palette entry and the keybind from dialogs.
 */
export function balancerLayer(open: () => void) {
	return {
		commands: [
			{
				bind: "ctrl+shift+b",
				id: "balancer.open",
				palette: true as const,
				run: open,
				title: copy.open,
			},
		],
		mode: "global" as const,
	};
}
