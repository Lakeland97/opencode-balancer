import { describe, expect, test } from "bun:test";
import { copy } from "../copy";
import { balancerLayer } from "../tui/layer";

describe("balancer TUI layer", () => {
	test("stays reachable from the command palette and every input mode", () => {
		const open = () => {};
		const layer = balancerLayer(open);
		// A `base` layer is unreachable while the palette dialog is open, so the
		// palette entry and ctrl+shift+b would silently disappear.
		expect(layer.mode).toBe("global");
		expect(layer.commands).toHaveLength(1);
		const [command] = layer.commands;
		expect(command.id).toBe("balancer.open");
		expect(command.title).toBe(copy.open);
		expect(command.bind).toBe("ctrl+shift+b");
		expect(command.palette).toBe(true);
		expect(command.run).toBe(open);
	});
});
