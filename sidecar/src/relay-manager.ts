import { Destination, RelayStatus } from "./types";
import { DirectRelay } from "./rtmp-relay";
import { FfmpegRelay } from "./ffmpeg-relay";

interface RelayBackend {
  start(): void;
  stop(): void;
  getStats(): { bitrateKbps: number };
}

interface RelayProcess {
  destination: Destination;
  relay: RelayBackend | null;
  status: "idle" | "live" | "error";
  error?: string;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  bitrateKbps: number;
}

export interface RelayManagerCallbacks {
  onRelayStarted: (destinationId: string) => void;
  onRelayStopped: (destinationId: string, reason: string) => void;
  onRelayError: (destinationId: string, error: string) => void;
  onDebugLog?: (source: string, message: string) => void;
}

const MAX_RESTARTS = 5;
const BASE_RESTART_DELAY_MS = 5_000;
const MAX_RESTART_DELAY_MS = 60_000;

export class RelayManager {
  private relays = new Map<string, RelayProcess>();
  private ingestPort: number;
  private callbacks: RelayManagerCallbacks;
  private streamActive = false;
  private activeStreamKey: string | null = null;
  private pushing = false;

  constructor(ingestPort: number, callbacks: RelayManagerCallbacks) {
    this.ingestPort = ingestPort;
    this.callbacks = callbacks;
  }

  setIngestPort(port: number): void {
    this.ingestPort = port;
  }

  isPushing(): boolean {
    return this.pushing;
  }

  onStreamConnect(streamKey: string): void {
    this.streamActive = true;
    this.activeStreamKey = streamKey;
    this.callbacks.onDebugLog?.(
      "relay-manager",
      `Source stream connected: ${streamKey}`
    );
  }

  onStreamDisconnect(streamKey: string): void {
    if (this.activeStreamKey && this.activeStreamKey !== streamKey) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        `Ignoring disconnect for inactive stream key: ${streamKey}`
      );
      return;
    }

    this.streamActive = false;
    this.activeStreamKey = null;

    if (this.pushing) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        "Source disconnected — stopping all relays"
      );
      this.stopPushing();
    }
  }

  pushDestinations(): void {
    if (!this.streamActive || !this.activeStreamKey) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        "Cannot push: no active source stream"
      );
      return;
    }

    this.pushing = true;
    this.callbacks.onDebugLog?.("relay-manager", "Starting push to all enabled destinations");

    for (const [, relay] of this.relays) {
      relay.restartCount = 0;
      relay.stopped = false;
      if (relay.destination.enabled) {
        this.startRelay(relay);
      }
    }
  }

  stopPushing(): void {
    this.pushing = false;
    this.callbacks.onDebugLog?.("relay-manager", "Stopping push to all destinations");

    for (const [, relay] of this.relays) {
      this.stopRelay(relay, "push_stopped");
    }
  }

  addDestination(dest: Destination): void {
    const relay: RelayProcess = {
      destination: dest,
      relay: null,
      status: "idle",
      restartCount: 0,
      restartTimer: null,
      stopped: false,
      bitrateKbps: 0,
    };
    this.relays.set(dest.id, relay);
  }

  updateDestination(dest: Destination): void {
    const existing = this.relays.get(dest.id);
    if (!existing) {
      this.addDestination(dest);
      return;
    }

    const wasEnabled = existing.destination.enabled;
    const wasFfmpeg = existing.destination.useFfmpeg === true;
    const nowFfmpeg = dest.useFfmpeg === true;
    const backendChanged =
      wasFfmpeg !== nowFfmpeg ||
      (nowFfmpeg && existing.destination.ffmpegArgs !== dest.ffmpegArgs);
    const urlChanged =
      existing.destination.url !== dest.url ||
      existing.destination.streamKey !== dest.streamKey;

    existing.destination = dest;

    if (!this.pushing) return;

    if (!dest.enabled && wasEnabled) {
      existing.stopped = true;
      this.stopRelay(existing, "disabled");
    } else if (dest.enabled && !wasEnabled) {
      existing.stopped = false;
      existing.restartCount = 0;
      if (this.streamActive) {
        this.startRelay(existing);
      }
    } else if (dest.enabled && (urlChanged || backendChanged) && this.streamActive) {
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

  /** Snapshot bitrate stats from active relays. Call this on a periodic timer. */
  updateStats(): void {
    for (const [, relay] of this.relays) {
      if (relay.relay) {
        relay.bitrateKbps = relay.relay.getStats().bitrateKbps;
      }
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
        bitrateKbps: relay.bitrateKbps,
      });
    }
    return statuses;
  }

  stopAll(): void {
    this.pushing = false;
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
    if (relay.relay || relay.stopped) return;

    if (!this.activeStreamKey) {
      relay.status = "idle";
      this.callbacks.onDebugLog?.(
        "relay-manager",
        `Cannot start relay for ${relay.destination.name}: no active stream key`
      );
      return;
    }

    const inputUrl = `rtmp://127.0.0.1:${this.ingestPort}/live/${this.activeStreamKey}`;
    const outputUrl = this.buildRtmpUrl(relay.destination);
    const useFfmpeg = relay.destination.useFfmpeg === true;

    const callbacks = {
      onStarted: () => {
        relay.status = "live";
        relay.error = undefined;
        this.callbacks.onRelayStarted(relay.destination.id);
      },
      onStopped: (reason: string) => {
        relay.relay = null;
        relay.bitrateKbps = 0;
        if (relay.stopped) {
          relay.status = "idle";
          return;
        }
        if (this.streamActive && this.pushing) {
          relay.status = "error";
          relay.error = `Relay stopped: ${reason}`;
          relay.restartCount++;
          this.callbacks.onRelayError(relay.destination.id, relay.error);
          this.scheduleRestart(relay);
        } else {
          relay.status = "idle";
          this.callbacks.onRelayStopped(relay.destination.id, reason);
        }
      },
      onError: (error: string) => {
        relay.relay = null;
        relay.bitrateKbps = 0;
        relay.status = "error";
        relay.error = error;
        this.callbacks.onRelayError(relay.destination.id, error);
        if (!relay.stopped && this.streamActive && this.pushing) {
          relay.restartCount++;
          this.scheduleRestart(relay);
        }
      },
      onDebugLog: (message: string) => {
        this.callbacks.onDebugLog?.(
          `relay:${relay.destination.name}`,
          message
        );
      },
    };

    try {
      const backend: RelayBackend = useFfmpeg
        ? new FfmpegRelay(
            inputUrl,
            outputUrl,
            relay.destination.name,
            relay.destination.ffmpegArgs,
            callbacks
          )
        : new DirectRelay(inputUrl, outputUrl, relay.destination.name, callbacks);

      relay.relay = backend;
      relay.error = undefined;
      this.callbacks.onDebugLog?.(
        "relay-manager",
        `Starting ${useFfmpeg ? "ffmpeg" : "native"} relay for ${relay.destination.name}`
      );
      backend.start();
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

    if (relay.relay) {
      const directRelay = relay.relay;
      relay.relay = null;
      relay.bitrateKbps = 0;
      try {
        directRelay.stop();
      } catch {
        // already stopped
      }
      relay.status = "idle";
      this.callbacks.onRelayStopped(relay.destination.id, reason);
    }
  }

  private scheduleRestart(relay: RelayProcess): void {
    if (relay.stopped || !this.streamActive || !this.pushing) return;

    if (relay.restartCount >= MAX_RESTARTS) {
      relay.status = "error";
      relay.error = `Relay stopped after ${MAX_RESTARTS} failed attempts — disable and re-enable the destination to retry`;
      this.callbacks.onRelayError(relay.destination.id, relay.error);
      this.callbacks.onDebugLog?.(
        "relay-manager",
        `[${relay.destination.name}] Retry limit reached (${MAX_RESTARTS}), giving up`
      );
      return;
    }

    const delay = Math.min(
      BASE_RESTART_DELAY_MS * Math.pow(2, relay.restartCount - 1),
      MAX_RESTART_DELAY_MS
    );

    this.callbacks.onDebugLog?.(
      "relay-manager",
      `[${relay.destination.name}] Scheduling retry ${relay.restartCount}/${MAX_RESTARTS} in ${delay / 1000}s`
    );

    relay.restartTimer = setTimeout(() => {
      relay.restartTimer = null;
      if (!relay.stopped && this.streamActive && relay.destination.enabled && this.pushing) {
        this.startRelay(relay);
      }
    }, delay);
  }
}
