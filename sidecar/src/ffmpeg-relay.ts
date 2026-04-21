import { spawn, ChildProcess } from "child_process";
import { Readable } from "stream";
import * as fs from "fs";
import * as path from "path";

type FfmpegProcess = ChildProcess & { stdout: Readable; stderr: Readable };

export interface FfmpegRelayStats {
  bitrateKbps: number;
}

export interface FfmpegRelayCallbacks {
  onStarted: () => void;
  onStopped: (reason: string) => void;
  onError: (error: string) => void;
  onDebugLog: (message: string) => void;
}

const DEFAULT_OUTPUT_ARGS = ["-c", "copy"];
const SIGKILL_TIMEOUT_MS = 2000;

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

function parseFfmpegArgs(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_OUTPUT_ARGS];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [...DEFAULT_OUTPUT_ARGS];

  // Simple shell-lite tokenizer: handles single/double quotes; no escape sequences.
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens.length > 0 ? tokens : [...DEFAULT_OUTPUT_ARGS];
}

export class FfmpegRelay {
  private process: FfmpegProcess | null = null;
  private running = false;
  private starting = false;
  private readonly inputUrl: string;
  private readonly outputUrl: string;
  private readonly name: string;
  private readonly customArgs?: string;
  private readonly callbacks: FfmpegRelayCallbacks;
  private stderrBuffer = "";
  private lastStderrTail: string[] = [];
  private latestBitrateKbps = 0;
  private stopRequested = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    inputUrl: string,
    outputUrl: string,
    name: string,
    customArgs: string | undefined,
    callbacks: FfmpegRelayCallbacks
  ) {
    this.inputUrl = inputUrl;
    this.outputUrl = outputUrl;
    this.name = name;
    this.customArgs = customArgs;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running || this.starting) return;
    this.starting = true;

    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      this.starting = false;
      this.callbacks.onError(
        "Bundled ffmpeg binary not found. Reinstall the app or disable FFmpeg mode for this destination."
      );
      return;
    }

    const outputArgs = parseFfmpegArgs(this.customArgs);
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostats",
      "-progress",
      "pipe:2",
      "-i",
      this.inputUrl,
      ...outputArgs,
      "-f",
      "flv",
      this.outputUrl,
    ];

    this.callbacks.onDebugLog(
      `Spawning ffmpeg: ${ffmpegPath} ${args
        .map((a) => (a === this.outputUrl ? "<output>" : a))
        .join(" ")}`
    );

    let child: FfmpegProcess;
    try {
      child = spawn(ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }) as FfmpegProcess;
    } catch (err: unknown) {
      this.starting = false;
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onError(`Failed to spawn ffmpeg: ${msg}`);
      return;
    }

    this.process = child;
    this.running = true;
    this.starting = false;
    this.stopRequested = false;

    let startedEmitted = false;
    const markStarted = () => {
      if (startedEmitted) return;
      startedEmitted = true;
      this.callbacks.onStarted();
    };

    child.stdout.on("data", (data: Buffer) => {
      if (data.length > 0) {
        this.callbacks.onDebugLog(`[ffmpeg stdout] ${data.toString("utf-8").trim()}`);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      this.handleStderrChunk(data.toString("utf-8"), markStarted);
    });

    child.on("error", (err: Error) => {
      this.callbacks.onDebugLog(`ffmpeg error event: ${err.message}`);
      if (this.running) {
        this.running = false;
        this.cleanup();
        this.callbacks.onError(`FFmpeg process error: ${err.message}`);
      }
    });

    child.on("exit", (code, signal) => {
      this.running = false;
      this.process = null;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }

      if (this.stopRequested) {
        this.callbacks.onStopped("stopped");
        return;
      }

      const tail = this.lastStderrTail.slice(-5).join(" | ").trim();
      if (code === 0) {
        this.callbacks.onStopped("ffmpeg_exited");
      } else {
        const reason = signal
          ? `ffmpeg killed by signal ${signal}`
          : `ffmpeg exited with code ${code}`;
        const suffix = tail ? ` — ${tail}` : "";
        this.callbacks.onError(`${reason}${suffix}`);
      }
    });
  }

  stop(): void {
    if (!this.process || !this.running) {
      this.running = false;
      return;
    }
    this.stopRequested = true;
    try {
      this.process.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (this.process && !this.process.killed) {
        try {
          this.process.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, SIGKILL_TIMEOUT_MS);
  }

  getStats(): FfmpegRelayStats {
    return { bitrateKbps: this.latestBitrateKbps };
  }

  private handleStderrChunk(chunk: string, markStarted: () => void): void {
    this.stderrBuffer += chunk;
    let newlineIdx = this.stderrBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIdx).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1);
      if (line.length > 0) this.processStderrLine(line, markStarted);
      newlineIdx = this.stderrBuffer.indexOf("\n");
    }
  }

  private processStderrLine(line: string, markStarted: () => void): void {
    // `-progress pipe:2` emits key=value lines including `bitrate=1234.5kbits/s`
    // and eventually `progress=continue` / `progress=end`.
    const eq = line.indexOf("=");
    if (eq > 0 && !line.includes(" ")) {
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      switch (key) {
        case "bitrate": {
          const match = value.match(/([\d.]+)\s*k/i);
          if (match) {
            const kbps = Math.round(parseFloat(match[1]));
            if (!Number.isNaN(kbps)) {
              this.latestBitrateKbps = kbps;
              markStarted();
            }
          }
          return;
        }
        case "out_time_ms":
        case "out_time_us":
        case "total_size":
          markStarted();
          return;
        case "progress":
          return;
        default:
          return;
      }
    }

    // Non-progress warning/error line.
    this.lastStderrTail.push(line);
    if (this.lastStderrTail.length > 20) {
      this.lastStderrTail = this.lastStderrTail.slice(-20);
    }
    this.callbacks.onDebugLog(`[ffmpeg:${this.name}] ${line}`);
  }

  private cleanup(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    const child = this.process;
    this.process = null;
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}
