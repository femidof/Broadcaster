#!/usr/bin/env node

/**
 * Verifies that the sidecar and ffmpeg binaries exist in src-tauri/binaries/
 * and are not 0-byte placeholders. Automatically builds/downloads any that
 * are missing so that `tauri build` always produces a working app.
 */

import { execFileSync, execSync } from "child_process";
import { existsSync, statSync } from "fs";
import { resolve, join } from "path";

function expectedFfmpegVersion(targetTriple) {
  return targetTriple.includes("apple-darwin") ? "6.1.1" : "8.0";
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

function getHostTriple() {
  return execSync("rustc --print host-tuple", { encoding: "utf-8" }).trim();
}

function isBinaryReady(filePath) {
  if (!existsSync(filePath)) return false;
  return statSync(filePath).size > 0;
}

function isFfmpegReady(filePath, expectedVersion) {
  if (!isBinaryReady(filePath)) return false;
  try {
    const output = execFileSync(filePath, ["-version"], { encoding: "utf-8" });
    return output.startsWith(`ffmpeg version ${expectedVersion}`);
  } catch {
    return false;
  }
}

function main() {
  const { target: requestedTarget } = parseArgs();
  const targetTriple = requestedTarget || getHostTriple();
  const rootDir = resolve(import.meta.dirname, "..");
  const binariesDir = join(rootDir, "src-tauri", "binaries");
  const targetArgs = requestedTarget ? ` -- --target ${requestedTarget}` : "";

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const sidecarPath = join(binariesDir, `broadcaster-sidecar-${targetTriple}${ext}`);
  const ffmpegPath = join(binariesDir, `ffmpeg-${targetTriple}${ext}`);
  const ffmpegVersion = expectedFfmpegVersion(targetTriple);

  let needed = [];

  if (!isFfmpegReady(ffmpegPath, ffmpegVersion)) {
    needed.push("ffmpeg");
    console.log(`[ensure-binaries] FFmpeg ${ffmpegVersion} missing or outdated, downloading...`);
    execSync(`npm run ffmpeg:download${targetArgs}`, { cwd: rootDir, stdio: "inherit" });
  }

  if (!isBinaryReady(sidecarPath)) {
    needed.push("sidecar");
    console.log(`[ensure-binaries] sidecar binary missing or empty, building...`);
    execSync(`npm run sidecar:build${targetArgs}`, { cwd: rootDir, stdio: "inherit" });
  }

  if (needed.length === 0) {
    console.log(`[ensure-binaries] All binaries present for ${targetTriple}`);
  } else {
    console.log(`[ensure-binaries] Resolved: ${needed.join(", ")}`);
  }
}

main();
