#!/usr/bin/env bun
/**
 * Materialises the on-device cover super-resolution model the
 * NemuSuperResolution pod bundles (gitignored, ~2.4 MB download):
 *
 *   ios/Models/NemuSuperResolution/RealESRGAN-x4v3.mlmodelc   Real-ESRGAN x4v3 compact, mlprogram
 *   ios/Models/NemuSuperResolution/manifest.json               revision, hashes, provenance
 *
 * Source: the Core ML package published at
 * https://huggingface.co/arraypress/upscale-realesrgan
 * (RealESRGAN-x4v3.mlpackage, BSD-3-Clause, converted by arraypress with
 * coremltools 9.0 from TorchScript). Every source file is pinned by sha256
 * below, and the Hub repo by commit.
 *
 * Where the source package comes from, first match wins:
 *   --from <dir> / NEMU_SR_MODEL_DIR  a folder with the .mlpackage folder
 *   ~/Library/Caches/nemu/sr-model/<SOURCE_ID>   the local cache
 *   the Hugging Face repo at HF_REVISION (default; HF_ENDPOINT overrides the
 *                                       host, e.g. a mirror), into the cache
 *
 * The package is compiled with `xcrun coremlcompiler` (Xcode) into the
 * .mlmodelc folder the app loads. Re-running is a no-op when the manifest
 * already matches.
 *
 * Usage (from apps/mobile): bun run sr:model [--from <dir>] [--force]
 * then `pod install` in apps/mobile/ios.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SOURCE_ID = "realesrgan-x4v3-v1";
const PACKAGE = "RealESRGAN-x4v3.mlpackage";
const HF_REPO = "arraypress/upscale-realesrgan";
/** The Hub commit the pins below were published at. */
const HF_REVISION = "34c71b5fd20656423aaadb6ab59d7a836c12bce7";

/** sha256 and size of every source file, relative to the source folder. */
const PINNED: Record<string, { sha256: string; bytes: number }> = {
  [`${PACKAGE}/Manifest.json`]: {
    sha256: "b5e78984070abecb768efdd85737e575cbcc362761ce447c78f7bd9b8fd848a3",
    bytes: 617,
  },
  [`${PACKAGE}/Data/com.apple.CoreML/model.mlmodel`]: {
    sha256: "9c8bb3fea30a0f30daabe48e3783a599bc6cb4e57c0e2f1ebd2b19d8de9cb90d",
    bytes: 55_991,
  },
  [`${PACKAGE}/Data/com.apple.CoreML/weights/weight.bin`]: {
    sha256: "7a6088b2ee537938f380b9049fae2b85dad57b251d047ab8f5afd256417838ec",
    bytes: 2_437_344,
  },
};

const moduleDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const outDir = join(moduleDir, "ios", "Models", "NemuSuperResolution");
const cacheDir = join(homedir(), "Library", "Caches", "nemu", "sr-model", SOURCE_ID);

function fail(message: string): never {
  console.error(`fetch-sr-model: ${message}`);
  process.exit(1);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")))
      .on("error", reject);
  });
}

/** The pinned revision: a digest over the pinned file hashes. */
function pinnedRevision(): string {
  const digest = createHash("sha256");
  for (const key of Object.keys(PINNED).sort()) digest.update(`${key}:${PINNED[key]!.sha256}\n`);
  return `${SOURCE_ID}-${digest.digest("hex").slice(0, 12)}`;
}

async function verifySource(dir: string): Promise<string | null> {
  for (const [path, expected] of Object.entries(PINNED)) {
    const full = join(dir, path);
    if (!existsSync(full)) return `missing ${path}`;
    if (statSync(full).size !== expected.bytes) return `size mismatch for ${path}`;
    if ((await sha256File(full)) !== expected.sha256) return `sha256 mismatch for ${path}`;
  }
  return null;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (${result.status})`);
}

/** Downloads every pinned file from the Hub commit into the cache, verified. */
async function downloadFromHub(): Promise<string> {
  const endpoint = (process.env.HF_ENDPOINT?.trim() || "https://huggingface.co").replace(/\/+$/, "");
  console.log(`fetch-sr-model: downloading ${HF_REPO}@${HF_REVISION.slice(0, 8)} from ${endpoint}`);
  const work = mkdtempSync(join(tmpdir(), "nemu-sr-model-"));
  for (const [path, expected] of Object.entries(PINNED)) {
    const url = `${endpoint}/${HF_REPO}/resolve/${HF_REVISION}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url);
    if (!response.ok) fail(`download failed for ${path}: HTTP ${response.status} (${url})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== expected.bytes || actual !== expected.sha256) {
      fail(`downloaded ${path} does not match its pin (sha256 ${actual}, ${bytes.byteLength} bytes)`);
    }
    const target = join(work, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(dirname(cacheDir), { recursive: true });
  cpSync(work, cacheDir, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  return cacheDir;
}

async function resolveSource(): Promise<string> {
  const explicit = argument("--from") ?? process.env.NEMU_SR_MODEL_DIR;
  if (explicit) {
    const dir = resolve(explicit);
    const problem = await verifySource(dir);
    if (problem) fail(`${dir}: ${problem}`);
    return dir;
  }
  if (existsSync(cacheDir)) {
    const problem = await verifySource(cacheDir);
    if (!problem) return cacheDir;
    console.warn(`fetch-sr-model: ignoring cache ${cacheDir}: ${problem}`);
  }
  return downloadFromHub();
}

function compile(sourceDir: string, packageName: string, target: string, work: string): void {
  const out = join(work, packageName.replace(/\.mlpackage$/, ""));
  mkdirSync(out, { recursive: true });
  run("xcrun", ["coremlcompiler", "compile", join(sourceDir, packageName), out]);
  const compiled = readdirSync(out).find((name) => name.endsWith(".mlmodelc"));
  if (!compiled) fail(`coremlcompiler produced no .mlmodelc for ${packageName}`);
  renameSync(join(out, compiled), target);
}

function folderBytes(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + folderBytes(join(path, name)), 0);
}

async function main(): Promise<void> {
  const revision = pinnedRevision();
  const manifestPath = join(outDir, "manifest.json");
  if (!process.argv.includes("--force") && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { revision?: string };
      if (
        manifest.revision === revision &&
        existsSync(join(outDir, "RealESRGAN-x4v3.mlmodelc"))
      ) {
        cpSync(join(moduleDir, "SR-NOTICES.txt"), join(outDir, "SR-NOTICES.txt"));
        console.log(`fetch-sr-model: ${revision} already in place (${outDir})`);
        return;
      }
    } catch {
      // Rebuild below.
    }
  }

  const source = await resolveSource();
  if (source !== cacheDir) {
    // Keep a verified copy so later runs work without the original folder.
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(dirname(cacheDir), { recursive: true });
    cpSync(source, cacheDir, { recursive: true });
  }

  const work = mkdtempSync(join(tmpdir(), "nemu-sr-compile-"));
  const staging = join(work, "NemuSuperResolution");
  mkdirSync(staging);
  compile(source, PACKAGE, join(staging, "RealESRGAN-x4v3.mlmodelc"), work);
  cpSync(join(moduleDir, "SR-NOTICES.txt"), join(staging, "SR-NOTICES.txt"));
  const xcode = spawnSync("xcodebuild", ["-version"], { encoding: "utf8" }).stdout?.trim().replace(/\n/g, " ");
  const files: Record<string, number> = {};
  for (const name of readdirSync(staging)) files[name] = folderBytes(join(staging, name));
  if (Object.values(files).reduce((sum, value) => sum + value, 0) >= 50_000_000) {
    fail("compiled model exceeds the 50 MB bundle budget");
  }
  writeFileSync(
    join(staging, "manifest.json"),
    `${JSON.stringify(
      {
        revision,
        model: "arraypress/upscale-realesrgan RealESRGAN-x4v3.mlpackage",
        license: "BSD-3-Clause (Real-ESRGAN)",
        conversion: "coremltools 9.0 mlprogram, from TorchScript (torch 2.10.0), 2026-03-03",
        compiledWith: xcode ?? "unknown",
        sources: Object.fromEntries(Object.entries(PINNED).map(([path, pin]) => [path, pin.sha256])),
        bytes: files,
        totalBytes: Object.values(files).reduce((sum, value) => sum + value, 0),
      },
      null,
      2,
    )}\n`,
  );
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(dirname(outDir), { recursive: true });
  cpSync(staging, outDir, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  console.log(`fetch-sr-model: ${revision} in place (${outDir})`);
}

await main();
