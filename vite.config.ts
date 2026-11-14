import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

/** Stamped into the panel so a stale window is obvious at a glance. */
const now = new Date();
const pad = (value: number) => String(value).padStart(2, "0");
const builtAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

export default defineConfig({
	define: {
		__BALANCER_BUILT_AT__: JSON.stringify(builtAt),
	},
	plugins: [
		gui({ entry: "v2/gui.tsx", outFile: "v2/dist/gui-experimental.cjs" }),
	],
});
