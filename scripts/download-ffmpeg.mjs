#!/usr/bin/env node

/**
 * Downloads a static ffmpeg binary for the current platform
 * and places it in src-tauri/binaries/ with the correct target triple suffix.
 *
 * Uses pinned npm packages to get pre-built binaries. macOS stays on the
 * newest build that supports pre-Sequoia systems; Linux and Windows use 8.0.
 */

import { execFileSync, execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve, join } from "path";

const FFMPEG_SOURCES = {
  macos: {
    packageName: "ffmpeg-ffprobe-static",
    packageVersion: "6.1.2-rc.1",
    ffmpegVersion: "6.1.1",
    exportExpression: "require('ffmpeg-ffprobe-static').ffmpegPath",
  },
  other: {
    packageName: "ffmpeg-for-homebridge",
    packageVersion: "2.2.2",
    ffmpegVersion: "8.0",
    exportExpression: "require('ffmpeg-for-homebridge')",
  },
};

function getHostTriple() {
  return execSync("rustc --print host-tuple", { encoding: "utf-8" }).trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  let target = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) {
      target = args[++i];
    } else if (args[i] === "--force") {
      force = true;
    }
  }
  return { target, force };
}

function getFfmpegSource(targetTriple) {
  return targetTriple.includes("apple-darwin") ? FFMPEG_SOURCES.macos : FFMPEG_SOURCES.other;
}

function hasExpectedVersion(binaryPath, expectedVersion) {
  if (!existsSync(binaryPath) || statSync(binaryPath).size === 0) return false;
  try {
    const output = execFileSync(binaryPath, ["-version"], { encoding: "utf-8" });
    return output.startsWith(`ffmpeg version ${expectedVersion}`);
  } catch {
    return false;
  }
}

function main() {
  const { target: requestedTarget, force } = parseArgs();
  const targetTriple = requestedTarget || getHostTriple();

  const rootDir = resolve(import.meta.dirname, "..");
  const binariesDir = resolve(rootDir, "src-tauri", "binaries");
  const source = getFfmpegSource(targetTriple);

  if (!existsSync(binariesDir)) {
    mkdirSync(binariesDir, { recursive: true });
  }

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const destPath = join(binariesDir, `ffmpeg-${targetTriple}${ext}`);

  if (!force && hasExpectedVersion(destPath, source.ffmpegVersion)) {
    console.log(`FFmpeg ${source.ffmpegVersion} already exists: ${destPath}`);
    return;
  }

  console.log(
    `Installing ${source.packageName}@${source.packageVersion} for FFmpeg ${source.ffmpegVersion}...`
  );
  const tmpRoot = join(rootDir, ".ffmpeg-tmp");
  const tmpDir = join(tmpRoot, "package");
  rmSync(tmpRoot, { recursive: true, force: true });
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  try {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "broadcaster-ffmpeg-download", private: true }),
      "utf-8"
    );
    execSync(`npm install --save-exact ${source.packageName}@${source.packageVersion}`, {
      cwd: tmpDir,
      stdio: "inherit",
    });

    const ffmpegStaticPath = execSync(
      `node -e "console.log(${source.exportExpression})"`,
      { cwd: tmpDir, encoding: "utf-8" }
    ).trim();

    if (!existsSync(ffmpegStaticPath)) {
      throw new Error(`FFmpeg binary not found at ${ffmpegStaticPath}`);
    }

    copyFileSync(ffmpegStaticPath, destPath);
    if (!targetTriple.includes("windows")) {
      chmodSync(destPath, 0o755);
    }

    console.log(`FFmpeg binary copied to: ${destPath}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
