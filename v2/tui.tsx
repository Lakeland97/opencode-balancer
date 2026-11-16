import { Plugin } from "@opencode/plugin/tui";
import { copy } from "./copy";
import { Balancer } from "./rpc";
import { BalancerPanel } from "./tui/panel";

export default Plugin.define({
	id: "balancer.tui",
	setup(ctx) {
		const closeSlot = ctx.ui.slot({
			append: "session.panel",
			render: (panel) =>
				panel.name === "balancer.panel" ? (
					<BalancerPanel ctx={ctx} panel={panel} />
				) : null,
		});

		const open = () => {
			if (!ctx.ui.panel.open("balancer.panel")) {
				ctx.ui.toast.show({ message: copy.openSession });
			}
		};

		ctx.keymap.layer(() => ({
			commands: [
				{
					bind: "ctrl+shift+b",
					id: "balancer.open",
					palette: true,
					run: open,
					title: copy.open,
				},
			],
		}));

		const offOpen = ctx.client.rpc(Balancer).events.on("open", open);

		return () => {
			offOpen();
			closeSlot();
		};
	},
});
