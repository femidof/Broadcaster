#!/usr/bin/env node

/**
 * Downloads a static ffmpeg binary for the current platform
 * and places it in src-tauri/binaries/ with the correct target triple suffix.
 *
 * Uses the ffmpeg-static npm package to get pre-built binaries.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { resolve, join } from "path";

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

  const rootDir = resolve(import.meta.dirname, "..");
  const binariesDir = resolve(rootDir, "src-tauri", "binaries");

  if (!existsSync(binariesDir)) {
    mkdirSync(binariesDir, { recursive: true });
  }

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const destPath = join(binariesDir, `ffmpeg-${targetTriple}${ext}`);

  if (existsSync(destPath)) {
    console.log(`FFmpeg binary already exists: ${destPath}`);
    return;
  }

  // Install ffmpeg-static temporarily to get the binary
  console.log("Installing ffmpeg-static to get binary...");
  const tmpDir = join(rootDir, ".ffmpeg-tmp");
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  try {
    execSync("npm init -y", { cwd: tmpDir, stdio: "pipe" });
    execSync("npm install ffmpeg-static", {
      cwd: tmpDir,
      stdio: "inherit",
    });

    const ffmpegStaticPath = execSync(
      'node -e "console.log(require(\'ffmpeg-static\'))"',
      { cwd: tmpDir, encoding: "utf-8" }
    ).trim();

    if (!existsSync(ffmpegStaticPath)) {
      throw new Error(`ffmpeg-static binary not found at ${ffmpegStaticPath}`);
    }

    copyFileSync(ffmpegStaticPath, destPath);
    if (!targetTriple.includes("windows")) {
      chmodSync(destPath, 0o755);
    }

    console.log(`FFmpeg binary copied to: ${destPath}`);
  } finally {
    // Clean up temp directory
    execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" });
  }
}

main();
