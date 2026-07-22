import esbuild from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  // The Obsidian plugin runs on desktop and iOS/Android. Keep the bundle
  // browser-compatible; the only external runtime modules are Obsidian and
  // Electron APIs supplied by the host.
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});

if (production) {
  const output = "main.js";
  const bundled = await readFile(output, "utf8");
  await writeFile(output, bundled.replace(/[ \t]+$/gm, ""));
}
