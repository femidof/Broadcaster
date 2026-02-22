#!/usr/bin/env node

import { execSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { resolve, join } from "path";

const PLATFORM_MAP = {
  "aarch64-apple-darwin": { pkg: "node22-macos-arm64", ext: "" },
  "x86_64-apple-darwin": { pkg: "node22-macos-x64", ext: "" },
  "x86_64-pc-windows-msvc": { pkg: "node22-win-x64", ext: ".exe" },
  "x86_64-unknown-linux-gnu": { pkg: "node22-linux-x64", ext: "" },
  "aarch64-unknown-linux-gnu": { pkg: "node22-linux-arm64", ext: "" },
};

function getHostTriple() {
  return execSync("rustc --print host-tuple", { encoding: "utf-8" }).trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  let target = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) {
      target = args[++i];
    }
  }
  return { target };
}

function main() {
  const { target: requestedTarget } = parseArgs();
  const targetTriple = requestedTarget || getHostTriple();
  const platformInfo = PLATFORM_MAP[targetTriple];

  if (!platformInfo) {
    console.error(`Unsupported target: ${targetTriple}`);
    console.error(`Supported targets: ${Object.keys(PLATFORM_MAP).join(", ")}`);
    process.exit(1);
  }

  const sidecarDir = resolve(import.meta.dirname);
  const binariesDir = resolve(sidecarDir, "..", "src-tauri", "binaries");

  if (!existsSync(binariesDir)) {
    mkdirSync(binariesDir, { recursive: true });
  }

  // Step 1: Compile TypeScript
  console.log("Compiling TypeScript...");
  execSync("npx tsc", { cwd: sidecarDir, stdio: "inherit" });

  // Step 2: Package with pkg
  const pkgOutput = join(sidecarDir, `broadcaster-sidecar${platformInfo.ext}`);
  console.log(`Packaging for ${targetTriple} (${platformInfo.pkg})...`);
  execSync(
    `npx pkg dist/index.js --targets ${platformInfo.pkg} --output "${pkgOutput}" --compress Brotli`,
    { cwd: sidecarDir, stdio: "inherit" }
  );

  // Step 3: Copy to binaries with target triple name
  const finalName = `broadcaster-sidecar-${targetTriple}${platformInfo.ext}`;
  const finalPath = join(binariesDir, finalName);
  copyFileSync(pkgOutput, finalPath);

  // Clean up the intermediate binary
  try {
    unlinkSync(pkgOutput);
  } catch {
    // non-critical
  }

  console.log(`Sidecar built: ${finalPath}`);
  console.log(`Target triple: ${targetTriple}`);
}

main();
