import esbuild from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const production = process.argv.includes("--production");
const apiBaseUrl = process.env.OBSIDIAN_API_BASE_URL?.trim() || "https://api.wetongbu.com";
let parsedApiBase;
try { parsedApiBase = new URL(apiBaseUrl); } catch { throw new Error("OBSIDIAN_API_BASE_URL must be an absolute HTTPS URL"); }
if (parsedApiBase.protocol !== "https:" || parsedApiBase.username || parsedApiBase.password || parsedApiBase.port
  || (parsedApiBase.pathname !== "/" && parsedApiBase.pathname !== "")
  || !/^(?:api|staging-api|test-api)\.wetongbu\.com$/i.test(parsedApiBase.hostname)) {
  throw new Error("OBSIDIAN_API_BASE_URL host is not an approved WeTongbu environment");
}
const normalizedApiBaseUrl = `https://${parsedApiBase.hostname.toLowerCase()}`;

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
  define: {
    WETONGBU_API_BASE_URL: JSON.stringify(normalizedApiBaseUrl),
  },
  logLevel: "info",
});

if (production) {
  const output = "main.js";
  const bundled = await readFile(output, "utf8");
  const withoutCommonJsDirective = bundled.replace(/^"use strict";/, "");
  await writeFile(output, withoutCommonJsDirective.replace(/[ \t]+$/gm, ""));
}
