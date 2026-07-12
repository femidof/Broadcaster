import { Destination, RelayStatus, SLATE_RTMP_STREAM_KEY, StreamFallbackSlate } from "./types";
import { DirectRelay } from "./rtmp-relay";
import { FfmpegRelay } from "./ffmpeg-relay";
import { SlateInjector } from "./slate-injector";

interface RelayBackend {
  start(): void;
  stop(): void;
  getStats(): { bitrateKbps: number };
  /** Swap pull source without closing the publish socket (native only; FFmpeg restarts). */
  switchInput?(newInputUrl: string): void;
  /** Loop last cached keyframe on the publisher while the new source warms up (native only). */
  holdLastFrame?(fps?: number): void;
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
/** Ms to wait after slate injector launches before switching relays to it. */
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
  /** Debounce / hold-last-frame timer before switching to slate. */
  private slateGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Settle wait after slate injector launches. */
  private slateInjectorSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stop-after duration timer. Fires stopPushing() when timed limit is reached. */
  private fallbackDurationTimer: ReturnType<typeof setTimeout> | null = null;
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

  private clearFallbackDurationTimer(): void {
    if (this.fallbackDurationTimer) {
      clearTimeout(this.fallbackDurationTimer);
      this.fallbackDurationTimer = null;
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

  private needsRelayResume(): boolean {
    for (const [, r] of this.relays) {
      if (!r.destination.enabled || r.stopped) continue;
      if (!r.relay) return true;
    }
    return false;
  }

  /**
   * Switch every live relay's pull source to `streamKey` without touching the
   * publish socket. If a relay has no backend yet (e.g. it errored out), start
   * it fresh. This is the core of the persistent-keepalive mechanism.
   */
  private switchAllRelaysToKey(streamKey: string): void {
    this.callbacks.onDebugLog?.(
      "relay-manager",
      `Switching all relays to ingest key: ${streamKey}`
    );
    const inputUrl = `rtmp://127.0.0.1:${this.ingestPort}/live/${streamKey}`;
    for (const [, relay] of this.relays) {
      if (!relay.destination.enabled || relay.stopped) continue;
      if (relay.relay?.switchInput) {
        relay.relay.switchInput(inputUrl);
      } else if (relay.relay) {
        // Backend doesn't support switchInput (shouldn't happen) — fall back to restart
        this.stopRelay(relay, "input_swap");
        relay.restartCount = 0;
        relay.error = undefined;
        this.startRelay(relay, streamKey);
      } else {
        // No running relay (errored/never started) — start fresh
        relay.restartCount = 0;
        relay.error = undefined;
        this.startRelay(relay, streamKey);
      }
    }
  }

  /**
   * Start the slate injector, then after the settle window call `onReady`.
   * Returns false if the injector fails to launch.
   */
  private launchSlateInjector(
    slate: StreamFallbackSlate,
    onReady: () => void
  ): void {
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
      this.callbacks.onDebugLog?.("relay-manager", "Slate injector failed to start — stopping push");
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
      onReady();
    }, SLATE_INJECTOR_SETTLE_MS);
  }

  /**
   * Start the stop-after timer (only when durationMode === "stop_after").
   * When it fires and OBS is still disconnected, stopPushing() is called.
   */
  private startFallbackDurationTimer(slate: StreamFallbackSlate): void {
    this.clearFallbackDurationTimer();
    if (slate.durationMode !== "stop_after") return;
    const ms = slate.stopAfterMs > 0 ? slate.stopAfterMs : 300_000;
    this.callbacks.onDebugLog?.(
      "relay-manager",
      `Fallback duration timer: stop after ${ms / 1000}s`
    );
    this.fallbackDurationTimer = setTimeout(() => {
      this.fallbackDurationTimer = null;
      if (this.pushing && this.slateMode && !this.obsConnected) {
        this.callbacks.onDebugLog?.(
          "relay-manager",
          `Fallback duration limit reached (${ms / 1000}s) — stopping push`
        );
        this.stopPushing();
      }
    }, ms);
  }

  onStreamConnect(streamKey: string): void {
    if (streamKey === SLATE_RTMP_STREAM_KEY) return;

    this.clearSlateGraceTimer();
    this.clearFallbackDurationTimer();

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
      // Switch all relays back to OBS — publisher stays open
      this.switchAllRelaysToKey(streamKey);
      return;
    }

    if (this.needsRelayResume()) {
      this.switchAllRelaysToKey(streamKey);
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

    const slate = this.slateConfig;
    if (this.slateEligible() && slate) {
      this.clearSlateGraceTimer();
      this.clearSlateSettleTimer();

      if (slate.sourceMode === "last_frame_then_slate") {
        // Hold the last cached keyframe on all live native relays to keep the
        // publisher socket alive and media flowing while the slate warms up.
        this.callbacks.onDebugLog?.(
          "relay-manager",
          `OBS disconnected — holding last frame for ${slate.gracePeriodMs}ms then switching to slate`
        );
        for (const [, relay] of this.relays) {
          if (!relay.destination.enabled || relay.stopped) continue;
          relay.relay?.holdLastFrame?.();
        }
        // Immediately start the slate injector in the background so it's ready
        // when the hold window expires
        const sessionAtLaunch = this.slateInjectorSessionId + 1; // will be bumped in launchSlateInjector
        void sessionAtLaunch; // suppress lint

        // Start injector but delay the relay switch until after gracePeriodMs
        this.bumpSlateInjectorSession();
        this.slateInjector.stop();
        const sId = this.slateInjectorSessionId;
        const started = this.slateInjector.start(this.ingestPort, slate.mediaPath, {
          onExit: (code, signal) => {
            if (sId !== this.slateInjectorSessionId) return;
            this.callbacks.onDebugLog?.(
              "relay-manager",
              `Slate injector exited code=${code} signal=${signal ?? "none"}`
            );
            if (!this.pushing || this.obsConnected) return;
            this.callbacks.onDebugLog?.(
              "relay-manager",
              "Slate FFmpeg stopped while fallback active — stopping push"
            );
            this.stopPushing();
          },
          onDebugLog: (msg) => this.callbacks.onDebugLog?.("slate-injector", msg),
        });
        if (!started) {
          this.callbacks.onDebugLog?.("relay-manager", "Slate injector failed to start — stopping push");
          this.stopPushing();
          return;
        }

        const graceDelay = Math.max(0, slate.gracePeriodMs);
        this.slateGraceTimer = setTimeout(() => {
          this.slateGraceTimer = null;
          if (!this.pushing || this.obsConnected) return;
          this.slateMode = true;
          this.switchAllRelaysToKey(SLATE_RTMP_STREAM_KEY);
          this.startFallbackDurationTimer(slate);
        }, graceDelay);

      } else {
        // slate_only: switch immediately, with a short settle for slate FFmpeg to start
        this.callbacks.onDebugLog?.(
          "relay-manager",
          "OBS disconnected — launching slate injector (slate_only mode)"
        );
        this.launchSlateInjector(slate, () => {
          if (!this.pushing || this.obsConnected) return;
          this.slateMode = true;
          this.switchAllRelaysToKey(SLATE_RTMP_STREAM_KEY);
          this.startFallbackDurationTimer(slate);
        });
      }
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
    this.clearFallbackDurationTimer();
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
    this.clearFallbackDurationTimer();
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
      /**
       * Pull-side failure with publisher still alive (native relay only).
       * The publisher is kept open; we schedule a full restart only if the ingest
       * is recoverable. In practice this fires during unexpected pull drops — the
       * normal OBS→slate transition bumps pullSessionId first so this won't fire.
       */
      onPullFailed: (reason: string) => {
        relay.bitrateKbps = 0;
        if (relay.stopped || !this.pushing) {
          relay.status = "idle";
          // Backend still has a live publisher; stop it cleanly
          const b = relay.relay;
          relay.relay = null;
          try { b?.stop(); } catch { /* ignore */ }
          return;
        }
        this.callbacks.onDebugLog?.(
          `relay:${relay.destination.name}`,
          `Pull failed (${reason}) — scheduling relay restart`
        );
        relay.status = "error";
        relay.error = `Pull failed: ${reason}`;
        relay.restartCount++;
        this.callbacks.onRelayError(relay.destination.id, relay.error);
        if (this.ingestRecoverable()) {
          // Stop the whole backend (publisher included) then let scheduleRestart
          // create a fresh relay — this re-establishes the remote connection.
          const b = relay.relay;
          relay.relay = null;
          try { b?.stop(); } catch { /* ignore */ }
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
