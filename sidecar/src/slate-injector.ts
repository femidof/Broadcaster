import { spawn, spawnSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { SLATE_RTMP_STREAM_KEY } from "./types";

const SIGKILL_TIMEOUT_MS = 2000;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function resolveFfmpegPath(): string | null {
  const fromEnv = process.env.BROADCASTER_FFMPEG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const execDir = path.dirname(process.execPath);
  const ext = process.platform === "win32" ? ".exe" : "";
  const sibling = path.join(execDir, `ffmpeg${ext}`);
  if (fs.existsSync(sibling)) {
    return sibling;
  }

  return null;
}

function isImageMedia(absPath: string): boolean {
  return IMAGE_EXT.has(path.extname(absPath).toLowerCase());
}

/** FFmpeg -i probe: stderr lists `Audio:` when a recognized audio stream exists. */
function probeHasAudio(mediaPath: string, ffmpegPath: string): boolean {
  const r = spawnSync(ffmpegPath, ["-hide_banner", "-i", mediaPath], {
    windowsHide: true,
  });
  const stderr = r.stderr?.toString("utf-8") ?? "";
  return /\bAudio:\s/.test(stderr);
}

export interface SlateInjectorCallbacks {
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onDebugLog: (message: string) => void;
}

export class SlateInjector {
  private child: ChildProcess | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  start(port: number, mediaPath: string, callbacks: SlateInjectorCallbacks): boolean {
    if (this.child && !this.child.killed) return false;

    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      callbacks.onDebugLog("slate-injector: ffmpeg binary not found");
      callbacks.onExit(1, null);
      return false;
    }
    if (!fs.existsSync(mediaPath)) {
      callbacks.onDebugLog(`slate-injector: media file missing: ${mediaPath}`);
      callbacks.onExit(1, null);
      return false;
    }

    const outUrl = `rtmp://127.0.0.1:${port}/live/${SLATE_RTMP_STREAM_KEY}`;
    let args: string[];

    if (isImageMedia(mediaPath)) {
      args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        "-loop",
        "1",
        "-framerate",
        "30",
        "-i",
        mediaPath,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-tune",
        "stillimage",
        "-r",
        "30",
        "-g",
        "60",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        outUrl,
      ];
    } else if (probeHasAudio(mediaPath, ffmpegPath)) {
      args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        "-stream_loop",
        "-1",
        "-re",
        "-i",
        mediaPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        outUrl,
      ];
    } else {
      args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        "-stream_loop",
        "-1",
        "-re",
        "-i",
        mediaPath,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        outUrl,
      ];
    }

    callbacks.onDebugLog(`slate-injector: spawning ffmpeg → ${outUrl}`);

    let child: ChildProcess;
    try {
      child = spawn(ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onDebugLog(`slate-injector: spawn failed: ${msg}`);
      callbacks.onExit(1, null);
      return false;
    }

    this.child = child;

    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf-8").trim();
      if (line) callbacks.onDebugLog(`[slate-injector] ${line}`);
    });

    child.on("error", (err: Error) => {
      callbacks.onDebugLog(`slate-injector: process error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.child = null;
      callbacks.onExit(code, signal);
    });

    return true;
  }

  stop(): void {
    const proc = this.child;
    if (!proc || proc.killed) {
      this.child = null;
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (this.child && !this.child.killed) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      this.killTimer = null;
    }, SIGKILL_TIMEOUT_MS);
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }
}
