import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, "../..");
const production = process.argv.includes("--production");
const worker = process.argv.includes("--worker");
const apiBaseUrl = process.env.OBSIDIAN_API_BASE_URL?.trim() || "https://api.wetongbu.com";
const configuredOutput = process.env.OBSIDIAN_OUTPUT?.trim() || "apps/obsidian-plugin/main.js";
const outputPath = path.resolve(repositoryRoot, configuredOutput);

let parsedApiBase;
try { parsedApiBase = new URL(apiBaseUrl); } catch { throw new Error("OBSIDIAN_API_BASE_URL must be an absolute HTTPS URL"); }
if (parsedApiBase.protocol !== "https:" || parsedApiBase.username || parsedApiBase.password || parsedApiBase.port
  || (parsedApiBase.pathname !== "/" && parsedApiBase.pathname !== "")
  || !/^(?:api|staging-api|test-api)\.wetongbu\.com$/i.test(parsedApiBase.hostname)) {
  throw new Error("OBSIDIAN_API_BASE_URL host is not an approved WeTongbu environment");
}
const normalizedApiBaseUrl = `https://${parsedApiBase.hostname.toLowerCase()}`;
const externalPackages = new Set(["obsidian", "electron"]);

if (worker) {
  // Run in a temporary source copy so esbuild's native helper never reads the
  // privacy-protected repository path on macOS.
  const { default: esbuild } = await import("esbuild");
  const metafileOutputPath = process.env.OBSIDIAN_METAFILE_OUTPUT?.trim();
  const buildResult = await esbuild.build({
    absWorkingDir: process.cwd(),
    entryPoints: ["apps/obsidian-plugin/src/main.ts"],
    bundle: true,
    external: [...externalPackages],
    format: "cjs",
    platform: "browser",
    target: "es2022",
    outfile: outputPath,
    sourcemap: production ? false : "inline",
    minify: production,
    define: {
      WETONGBU_API_BASE_URL: JSON.stringify(normalizedApiBaseUrl),
    },
    logLevel: "info",
    metafile: Boolean(metafileOutputPath),
  });

  if (metafileOutputPath) {
    await mkdir(path.dirname(metafileOutputPath), { recursive: true });
    await writeFile(metafileOutputPath, `${JSON.stringify({ inputPaths: Object.keys(buildResult.metafile.inputs) }, null, 2)}\n`);
  }

  if (production) {
    const bundled = await readFile(outputPath, "utf8");
    await writeFile(outputPath, bundled.replace(/[ \t]+$/gm, ""));
  }
} else {
  const stagingRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "wetongbu-obsidian-esbuild-")));
  const stagedSourceRoot = path.join(stagingRoot, "apps/obsidian-plugin/src");
  const stagedOutputPath = path.join(stagingRoot, "apps/obsidian-plugin/main.js");
  const configuredMetafileOutput = process.env.OBSIDIAN_METAFILE_OUTPUT?.trim();
  const stagedMetafilePath = configuredMetafileOutput ? path.join(stagingRoot, "obsidian-metafile.json") : null;
  const builtinPackageNames = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

  function packageNameFromSpecifier(specifier) {
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")
      || builtinPackageNames.has(specifier) || specifier.startsWith("node:")) return null;
    const segments = specifier.split("/");
    return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  }

  async function collectPackageSpecifiers(directory) {
    const found = new Set();
    const declarationPattern = /^\s*(?:import|export)\b[\s\S]*?;/gm;
    const declarationSourcePattern = /\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/m;
    const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;

    async function visit(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
        } else if (entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name)) {
          const source = await readFile(entryPath, "utf8");
          for (const declaration of source.matchAll(declarationPattern)) {
            const match = declarationSourcePattern.exec(declaration[0]);
            const packageName = packageNameFromSpecifier(match?.[1] || match?.[2]);
            if (packageName && !externalPackages.has(packageName)) found.add(packageName);
          }
          for (const match of source.matchAll(dynamicImportPattern)) {
            const packageName = packageNameFromSpecifier(match[1] || match[2]);
            if (packageName && !externalPackages.has(packageName)) found.add(packageName);
          }
        }
      }
    }

    await visit(directory);
    return found;
  }

  async function stagePackage(packageName, stagedNodeModules, stagedPackages) {
    if (stagedPackages.has(packageName)) return;
    stagedPackages.add(packageName);
    const packageSegments = packageName.split("/");
    const sourcePackage = path.join(repositoryRoot, "node_modules", ...packageSegments);
    const stagedPackage = path.join(stagedNodeModules, ...packageSegments);
    let packageMetadata;
    try {
      packageMetadata = JSON.parse(await readFile(path.join(sourcePackage, "package.json"), "utf8"));
    } catch {
      throw new Error(`Could not stage Obsidian bundle dependency: ${packageName}`);
    }
    await mkdir(path.dirname(stagedPackage), { recursive: true });
    await cp(sourcePackage, stagedPackage, { recursive: true, dereference: true });
    for (const dependency of Object.keys(packageMetadata.dependencies ?? {})) {
      await stagePackage(dependency, stagedNodeModules, stagedPackages);
    }
  }

  try {
    await mkdir(path.dirname(stagedSourceRoot), { recursive: true });
    await cp(path.join(pluginRoot, "src"), stagedSourceRoot, { recursive: true, dereference: true });

    const stagedNodeModules = path.join(stagingRoot, "node_modules");
    await mkdir(stagedNodeModules, { recursive: true });
    const stagedPackages = new Set();
    for (const packageName of await collectPackageSpecifiers(stagedSourceRoot)) {
      await stagePackage(packageName, stagedNodeModules, stagedPackages);
    }

    const build = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--worker", ...(production ? ["--production"] : [])],
      {
        cwd: stagingRoot,
        env: {
          PATH: process.env.PATH ?? "",
          OBSIDIAN_API_BASE_URL: normalizedApiBaseUrl,
          OBSIDIAN_OUTPUT: stagedOutputPath,
          ...(stagedMetafilePath ? { OBSIDIAN_METAFILE_OUTPUT: stagedMetafilePath } : {}),
        },
        encoding: "utf8",
      },
    );
    if (build.error) throw build.error;
    if (build.status !== 0) {
      throw new Error(`Obsidian bundle rebuild failed: ${(build.stderr || build.stdout).trim()}`);
    }

    let bundled = await readFile(stagedOutputPath, "utf8");
    if (!production) {
      const sourceMapPattern = /(\/\/# sourceMappingURL=data:application\/json;base64,)([A-Za-z0-9+/=]+)/;
      const match = sourceMapPattern.exec(bundled);
      if (match) {
        const sourceMap = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
        sourceMap.sources = sourceMap.sources.map((source) => {
          const absoluteSourcePath = path.resolve(path.dirname(stagedOutputPath), source);
          const stagedRelativePath = path.relative(stagingRoot, absoluteSourcePath);
          if (path.isAbsolute(stagedRelativePath) || stagedRelativePath.startsWith("..")) {
            throw new Error("Obsidian source map contains a path outside the staged source tree");
          }
          return stagedRelativePath.split(path.sep).join("/");
        });
        sourceMap.sourceRoot = path.relative(path.dirname(outputPath), repositoryRoot).split(path.sep).join("/");
        bundled = bundled.replace(match[0], `${match[1]}${Buffer.from(JSON.stringify(sourceMap)).toString("base64")}`);
      }
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bundled);
    if (configuredMetafileOutput && stagedMetafilePath) {
      const metadata = JSON.parse(await readFile(stagedMetafilePath, "utf8"));
      if (!Array.isArray(metadata.inputPaths) || metadata.inputPaths.length === 0) {
        throw new Error("Obsidian production metafile contains no input paths");
      }
      const inputPaths = metadata.inputPaths.map((inputPath) => {
        if (typeof inputPath !== "string" || !inputPath || inputPath.includes("\\") || path.isAbsolute(inputPath)) {
          throw new Error("Obsidian production metafile contains an unsafe input path");
        }
        const absoluteInputPath = path.resolve(stagingRoot, inputPath);
        const relativeInputPath = path.relative(stagingRoot, absoluteInputPath);
        if (!relativeInputPath || relativeInputPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeInputPath)) {
          throw new Error("Obsidian production metafile input escapes the staged source tree");
        }
        return relativeInputPath.split(path.sep).join("/");
      });
      if (new Set(inputPaths).size !== inputPaths.length) throw new Error("Obsidian production metafile contains duplicate input paths");
      const metafileOutput = path.resolve(repositoryRoot, configuredMetafileOutput);
      await mkdir(path.dirname(metafileOutput), { recursive: true });
      await writeFile(metafileOutput, `${JSON.stringify({ inputPaths }, null, 2)}\n`);
    }
    process.stdout.write(build.stdout || "");
    process.stderr.write(build.stderr || "");
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
