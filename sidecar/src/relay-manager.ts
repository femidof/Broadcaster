import { Destination, RelayStatus, SLATE_RTMP_STREAM_KEY, StreamFallbackSlate } from "./types";
import { DirectRelay } from "./rtmp-relay";
import { FfmpegRelay } from "./ffmpeg-relay";
import { SlateInjector } from "./slate-injector";

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
const SLATE_INJECTOR_SETTLE_MS = 800;

export class RelayManager {
  private relays = new Map<string, RelayProcess>();
  private ingestPort: number;
  private callbacks: RelayManagerCallbacks;
  /** OBS / encoder publishing to ingest (not slate injector). */
  private obsConnected = false;
  private obsStreamKey: string | null = null;
  private pushing = false;
  /** Relays are pulling slate FFmpeg publisher. */
  private slateMode = false;
  private slateInjector = new SlateInjector();
  private slateGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private slateInjectorSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped when intentionally stopping/replacing slate FFmpeg — ignores stale process exits. */
  private slateInjectorSessionId = 0;
  private slateConfig: StreamFallbackSlate | undefined;

  constructor(ingestPort: number, callbacks: RelayManagerCallbacks) {
    this.ingestPort = ingestPort;
    this.callbacks = callbacks;
  }

  setIngestPort(port: number): void {
    this.ingestPort = port;
  }

  /** Persisted profile settings for OBS disconnect fallback. */
  setStreamFallbackSlate(config: StreamFallbackSlate | undefined): void {
    this.slateConfig = config;
  }

  isPushing(): boolean {
    return this.pushing;
  }

  /** True while relays ingest the internal slate FFmpeg stream. */
  isSlateFallbackActive(): boolean {
    return this.slateMode;
  }

  private clearSlateGraceTimer(): void {
    if (this.slateGraceTimer) {
      clearTimeout(this.slateGraceTimer);
      this.slateGraceTimer = null;
    }
  }

  private clearSlateSettleTimer(): void {
    if (this.slateInjectorSettleTimer) {
      clearTimeout(this.slateInjectorSettleTimer);
      this.slateInjectorSettleTimer = null;
    }
  }

  private bumpSlateInjectorSession(): void {
    this.slateInjectorSessionId++;
  }

  private ingestRecoverable(): boolean {
    return this.obsConnected || this.slateMode;
  }

  private effectivePullStreamKey(): string | null {
    if (this.slateMode) return SLATE_RTMP_STREAM_KEY;
    return this.obsStreamKey;
  }

  private slateEligible(): boolean {
    const s = this.slateConfig;
    return !!(s?.enabled && s.mediaPath.trim().length > 0);
  }

  private haltRelays(reason: string): void {
    for (const [, relay] of this.relays) {
      this.stopRelay(relay, reason);
    }
  }

  private restartRelaysForStreamKey(streamKey: string): void {
    this.callbacks.onDebugLog?.(
      "relay-manager",
      `Restarting relays for ingest key ${streamKey}`
    );
    for (const [, relay] of this.relays) {
      if (!relay.destination.enabled || relay.stopped) continue;
      if (relay.relay) this.stopRelay(relay, "input_swap");
      relay.restartCount = 0;
      relay.error = undefined;
      this.startRelay(relay, streamKey);
    }
  }

  private needsRelayResume(): boolean {
    for (const [, r] of this.relays) {
      if (!r.destination.enabled || r.stopped) continue;
      if (!r.relay) return true;
    }
    return false;
  }

  private onSlateGraceElapsed(): void {
    this.slateGraceTimer = null;
    if (!this.pushing || this.obsConnected) return;

    const slate = this.slateConfig;
    if (!slate?.enabled || !slate.mediaPath.trim()) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        "Slate grace elapsed but slate disabled — stopping push"
      );
      this.stopPushing();
      return;
    }

    this.clearSlateSettleTimer();
    this.bumpSlateInjectorSession();
    this.slateInjector.stop();

    const sessionAtStart = this.slateInjectorSessionId;
    const started = this.slateInjector.start(this.ingestPort, slate.mediaPath, {
      onExit: (code, signal) => {
        if (sessionAtStart !== this.slateInjectorSessionId) return;
        this.callbacks.onDebugLog?.(
          "relay-manager",
          `Slate injector exited code=${code} signal=${signal ?? "none"}`
        );
        if (!this.pushing || this.obsConnected) return;
        this.callbacks.onDebugLog?.(
          "relay-manager",
          "Slate FFmpeg stopped while fallback was required — stopping push"
        );
        this.stopPushing();
      },
      onDebugLog: (msg) => this.callbacks.onDebugLog?.("slate-injector", msg),
    });

    if (!started) {
      this.callbacks.onDebugLog?.("relay-manager", "Slate injector failed to start");
      this.stopPushing();
      return;
    }

    this.slateInjectorSettleTimer = setTimeout(() => {
      this.slateInjectorSettleTimer = null;
      if (!this.pushing || this.obsConnected) {
        this.bumpSlateInjectorSession();
        this.slateInjector.stop();
        return;
      }
      this.slateMode = true;
      this.restartRelaysForStreamKey(SLATE_RTMP_STREAM_KEY);
    }, SLATE_INJECTOR_SETTLE_MS);
  }

  onStreamConnect(streamKey: string): void {
    if (streamKey === SLATE_RTMP_STREAM_KEY) return;

    this.clearSlateGraceTimer();

    this.obsConnected = true;
    this.obsStreamKey = streamKey;
    this.callbacks.onDebugLog?.(
      "relay-manager",
      `Source stream connected: ${streamKey}`
    );

    if (!this.pushing) return;

    if (this.slateMode) {
      this.clearSlateSettleTimer();
      this.bumpSlateInjectorSession();
      this.slateMode = false;
      this.slateInjector.stop();
      this.restartRelaysForStreamKey(streamKey);
      return;
    }

    if (this.needsRelayResume()) {
      this.restartRelaysForStreamKey(streamKey);
    }
  }

  onStreamDisconnect(streamKey: string): void {
    if (streamKey === SLATE_RTMP_STREAM_KEY) return;

    if (this.obsStreamKey && this.obsStreamKey !== streamKey) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        `Ignoring disconnect for inactive stream key: ${streamKey}`
      );
      return;
    }

    this.obsConnected = false;
    this.obsStreamKey = null;

    if (!this.pushing) return;

    if (this.slateEligible()) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        "OBS disconnected — halting relays for slate fallback grace period"
      );
      this.clearSlateGraceTimer();
      this.clearSlateSettleTimer();
      this.haltRelays("obs_disconnected");
      const delay = Math.max(0, this.slateConfig!.gracePeriodMs);
      this.slateGraceTimer = setTimeout(() => this.onSlateGraceElapsed(), delay);
      return;
    }

    this.callbacks.onDebugLog?.(
      "relay-manager",
      "Source disconnected — stopping all relays"
    );
    this.stopPushing();
  }

  pushDestinations(): void {
    if (!this.obsConnected || !this.obsStreamKey) {
      this.callbacks.onDebugLog?.(
        "relay-manager",
        "Cannot push: no active source stream"
      );
      return;
    }

    this.pushing = true;
    this.callbacks.onDebugLog?.("relay-manager", "Starting push to all enabled destinations");

    const pullKey = this.obsStreamKey;
    for (const [, relay] of this.relays) {
      relay.restartCount = 0;
      relay.stopped = false;
      if (relay.destination.enabled) {
        this.startRelay(relay, pullKey);
      }
    }
  }

  stopPushing(): void {
    this.clearSlateGraceTimer();
    this.clearSlateSettleTimer();
    this.bumpSlateInjectorSession();
    this.slateInjector.stop();
    this.slateMode = false;

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

    const pullKey = this.effectivePullStreamKey();

    if (!dest.enabled && wasEnabled) {
      existing.stopped = true;
      this.stopRelay(existing, "disabled");
    } else if (dest.enabled && !wasEnabled) {
      existing.stopped = false;
      existing.restartCount = 0;
      if (pullKey) {
        this.startRelay(existing, pullKey);
      }
    } else if (dest.enabled && (urlChanged || backendChanged) && pullKey) {
      this.stopRelay(existing, "config_changed");
      existing.restartCount = 0;
      setTimeout(() => this.startRelay(existing, pullKey!), 500);
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
    this.clearSlateGraceTimer();
    this.clearSlateSettleTimer();
    this.bumpSlateInjectorSession();
    this.slateInjector.stop();
    this.slateMode = false;

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

  private startRelay(relay: RelayProcess, pullStreamKey?: string): void {
    if (relay.relay || relay.stopped) return;

    const key = pullStreamKey ?? this.effectivePullStreamKey();
    if (!key) {
      relay.status = "idle";
      this.callbacks.onDebugLog?.(
        "relay-manager",
        `Cannot start relay for ${relay.destination.name}: no ingest stream key`
      );
      return;
    }

    const inputUrl = `rtmp://127.0.0.1:${this.ingestPort}/live/${key}`;
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
        if (this.ingestRecoverable() && this.pushing) {
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
        if (!relay.stopped && this.ingestRecoverable() && this.pushing) {
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
    const pullKey = this.effectivePullStreamKey();
    if (relay.stopped || !this.pushing || !pullKey) return;

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
      const key = this.effectivePullStreamKey();
      if (
        !relay.stopped &&
        relay.destination.enabled &&
        this.pushing &&
        key &&
        this.ingestRecoverable()
      ) {
        this.startRelay(relay, key);
      }
    }, delay);
  }
}
