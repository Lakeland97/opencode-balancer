import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		gui({ entry: "v2/gui.tsx", outFile: "v2/dist/gui-experimental.cjs" }),
	],
});
