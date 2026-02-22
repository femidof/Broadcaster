import { ChildProcess, spawn } from "child_process";
import { Destination, RelayStatus } from "./types";

interface RelayProcess {
  destination: Destination;
  process: ChildProcess | null;
  status: "idle" | "live" | "error";
  error?: string;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

export interface RelayManagerCallbacks {
  onRelayStarted: (destinationId: string) => void;
  onRelayStopped: (destinationId: string, reason: string) => void;
  onRelayError: (destinationId: string, error: string) => void;
}

export class RelayManager {
  private relays = new Map<string, RelayProcess>();
  private ffmpegPath: string;
  private ingestPort: number;
  private callbacks: RelayManagerCallbacks;
  private streamActive = false;

  constructor(
    ffmpegPath: string,
    ingestPort: number,
    callbacks: RelayManagerCallbacks
  ) {
    this.ffmpegPath = ffmpegPath;
    this.ingestPort = ingestPort;
    this.callbacks = callbacks;
  }

  setIngestPort(port: number): void {
    this.ingestPort = port;
  }

  onStreamConnect(): void {
    this.streamActive = true;
    for (const [, relay] of this.relays) {
      if (relay.destination.enabled && !relay.stopped) {
        this.startRelay(relay);
      }
    }
  }

  onStreamDisconnect(): void {
    this.streamActive = false;
    for (const [, relay] of this.relays) {
      this.stopRelay(relay, "source_disconnected");
    }
  }

  addDestination(dest: Destination): void {
    const relay: RelayProcess = {
      destination: dest,
      process: null,
      status: "idle",
      restartCount: 0,
      restartTimer: null,
      stopped: false,
    };
    this.relays.set(dest.id, relay);

    if (dest.enabled && this.streamActive) {
      this.startRelay(relay);
    }
  }

  updateDestination(dest: Destination): void {
    const existing = this.relays.get(dest.id);
    if (!existing) {
      this.addDestination(dest);
      return;
    }

    const wasEnabled = existing.destination.enabled;
    const urlChanged =
      existing.destination.url !== dest.url ||
      existing.destination.streamKey !== dest.streamKey;

    existing.destination = dest;

    if (!dest.enabled && wasEnabled) {
      existing.stopped = true;
      this.stopRelay(existing, "disabled");
    } else if (dest.enabled && !wasEnabled) {
      existing.stopped = false;
      existing.restartCount = 0;
      if (this.streamActive) {
        this.startRelay(existing);
      }
    } else if (dest.enabled && urlChanged && this.streamActive) {
      this.stopRelay(existing, "config_changed");
      existing.restartCount = 0;
      setTimeout(() => this.startRelay(existing), 500);
    }
  }

  removeDestination(id: string): void {
    const relay = this.relays.get(id);
    if (relay) {
      relay.stopped = true;
      this.stopRelay(relay, "removed");
      this.relays.delete(id);
    }
  }

  getStatuses(): RelayStatus[] {
    const statuses: RelayStatus[] = [];
    for (const [, relay] of this.relays) {
      statuses.push({
        destinationId: relay.destination.id,
        name: relay.destination.name,
        status: relay.status,
        error: relay.error,
        restartCount: relay.restartCount,
      });
    }
    return statuses;
  }

  stopAll(): void {
    for (const [, relay] of this.relays) {
      relay.stopped = true;
      this.stopRelay(relay, "shutdown");
    }
  }

  private buildRtmpUrl(dest: Destination): string {
    const base = dest.url.endsWith("/") ? dest.url : dest.url + "/";
    return `${base}${dest.streamKey}`;
  }

  private startRelay(relay: RelayProcess): void {
    if (relay.process || relay.stopped) return;

    const inputUrl = `rtmp://127.0.0.1:${this.ingestPort}/live/stream`;
    const outputUrl = this.buildRtmpUrl(relay.destination);

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rw_timeout",
      "10000000",
      "-i",
      inputUrl,
      "-c",
      "copy",
      "-f",
      "flv",
      "-flvflags",
      "no_duration_filesize",
      outputUrl,
    ];

    try {
      const proc = spawn(this.ffmpegPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      relay.process = proc;
      relay.status = "live";
      relay.error = undefined;
      this.callbacks.onRelayStarted(relay.destination.id);

      proc.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.error(
            `[ffmpeg:${relay.destination.name}] ${msg}`
          );
        }
      });

      proc.on("close", (code) => {
        relay.process = null;

        if (relay.stopped) {
          relay.status = "idle";
          return;
        }

        if (code !== 0 && this.streamActive) {
          relay.status = "error";
          relay.error = `FFmpeg exited with code ${code}`;
          relay.restartCount++;
          this.callbacks.onRelayError(
            relay.destination.id,
            relay.error
          );
          this.scheduleRestart(relay);
        } else {
          relay.status = "idle";
          this.callbacks.onRelayStopped(
            relay.destination.id,
            `exited with code ${code}`
          );
        }
      });

      proc.on("error", (err) => {
        relay.process = null;
        relay.status = "error";
        relay.error = err.message;
        this.callbacks.onRelayError(relay.destination.id, err.message);

        if (!relay.stopped && this.streamActive) {
          relay.restartCount++;
          this.scheduleRestart(relay);
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      relay.status = "error";
      relay.error = msg;
      this.callbacks.onRelayError(relay.destination.id, msg);
    }
  }

  private stopRelay(relay: RelayProcess, reason: string): void {
    if (relay.restartTimer) {
      clearTimeout(relay.restartTimer);
      relay.restartTimer = null;
    }

    if (relay.process) {
      const proc = relay.process;
      relay.process = null;
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, 3000);
      } catch {
        // already dead
      }
      relay.status = "idle";
      this.callbacks.onRelayStopped(relay.destination.id, reason);
    }
  }

  private scheduleRestart(relay: RelayProcess): void {
    if (relay.stopped || !this.streamActive) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(
      1000 * Math.pow(2, relay.restartCount - 1),
      30000
    );

    relay.restartTimer = setTimeout(() => {
      relay.restartTimer = null;
      if (!relay.stopped && this.streamActive && relay.destination.enabled) {
        this.startRelay(relay);
      }
    }, delay);
  }
}
