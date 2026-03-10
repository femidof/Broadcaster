import { useState, useEffect, useCallback, useRef } from "react";
import { Layout, type TabId } from "@/components/layout";
import { Dashboard } from "@/components/dashboard";
import { DestinationsPanel } from "@/components/destinations-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { type DebugLogEntry } from "@/components/debug-panel";
import type { AppStatus, Destination, SidecarEvent } from "@/lib/types";
import * as api from "@/lib/tauri";
import { featureFlags } from "@/lib/feature-flags";
import { ConnectionDoctor } from "@/components/reliability/connection-doctor";

const MAX_DEBUG_LOGS = 500;
const MAX_BITRATE_POINTS = 300; // ~10 min at 2s cadence

type BitratePoint = { t: number; kbps: number };
type BitrateSeries = Record<string, BitratePoint[]>;

type SessionAccum = {
  startTs: number;
  perDest: Record<
    string,
    { sumKbps: number; count: number; maxKbps: number; lastKbps: number }
  >;
};

export type SessionSummary = {
  startTs: number;
  endTs: number;
  durationMs: number;
  perDest: Record<string, { avgKbps: number; maxKbps: number; samples: number }>;
  restarts: Record<string, number>;
  errors: Record<string, string | undefined>;
};

const DEFAULT_STATUS: AppStatus = {
  serverRunning: false,
  port: 1935,
  streamActive: false,
  pushing: false,
  relays: [],
  destinations: [],
  debugMode: false,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [status, setStatus] = useState<AppStatus>(DEFAULT_STATUS);
  const [autoStart, setAutoStart] = useState(true);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const logIdRef = useRef(0);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorContext, setDoctorContext] = useState<Destination | null>(null);
  const [bitrateSeries, setBitrateSeries] = useState<BitrateSeries>({});
  const pushingRef = useRef(false);
  const sessionRef = useRef<SessionAccum | null>(null);
  const pushingPrevRef = useRef(false);
  const [lastSession, setLastSession] = useState<SessionSummary | null>(null);

  const pushDebugLog = useCallback(
    (source: string, message: string, level: DebugLogEntry["level"], timestamp?: number) => {
      setDebugLogs((prev) => {
        const entry: DebugLogEntry = {
          id: ++logIdRef.current,
          source,
          message,
          timestamp: timestamp ?? Date.now(),
          level,
        };
        const next = [...prev, entry];
        return next.length > MAX_DEBUG_LOGS ? next.slice(-MAX_DEBUG_LOGS) : next;
      });
    },
    []
  );

  const handleSidecarEvent = useCallback((event: SidecarEvent) => {
    switch (event.event) {
      case "ready":
        api.getStatus().catch(console.error);
        break;

      case "server_started":
        setStatus((prev) => ({
          ...prev,
          serverRunning: true,
          port: event.port,
        }));
        break;

      case "server_stopped":
        setStatus((prev) => ({
          ...prev,
          serverRunning: false,
          streamActive: false,
          relays: prev.relays.map((r) => ({ ...r, status: "idle" as const, bitrateKbps: 0 })),
        }));
        break;

      case "stream_connected":
        setStatus((prev) => ({ ...prev, streamActive: true }));
        break;

      case "stream_disconnected":
        pushingRef.current = false;
        setStatus((prev) => ({
          ...prev,
          streamActive: false,
          pushing: false,
          relays: prev.relays.map((r) => ({ ...r, status: "idle" as const, bitrateKbps: 0 })),
        }));
        break;

      case "relay_started":
        setStatus((prev) => ({
          ...prev,
          relays: prev.relays.map((r) =>
            r.destinationId === event.destinationId
              ? { ...r, status: "live" as const, error: undefined }
              : r
          ),
        }));
        break;

      case "relay_stopped":
        setStatus((prev) => ({
          ...prev,
          relays: prev.relays.map((r) =>
            r.destinationId === event.destinationId
              ? { ...r, status: "idle" as const, bitrateKbps: 0 }
              : r
          ),
        }));
        break;

      case "relay_error":
        setStatus((prev) => ({
          ...prev,
          relays: prev.relays.map((r) =>
            r.destinationId === event.destinationId
              ? { ...r, status: "error" as const, error: event.error, bitrateKbps: 0 }
              : r
          ),
        }));
        break;

      case "status":
        pushingRef.current = event.pushing;
        setStatus({
          serverRunning: event.serverRunning,
          port: event.port,
          streamActive: event.streamActive,
          pushing: event.pushing,
          relays: event.relays,
          destinations: event.destinations,
          debugMode: event.debugMode,
        });
        break;

      case "destinations_updated":
        setStatus((prev) => ({
          ...prev,
          destinations: event.destinations,
        }));
        break;

      case "relay_stats":
        setStatus((prev) => ({
          ...prev,
          relays: prev.relays.map((r) => {
            const updated = event.relays.find(
              (s) => s.destinationId === r.destinationId
            );
            return updated
              ? { ...r, bitrateKbps: updated.bitrateKbps }
              : r;
          }),
        }));
        if (featureFlags.analytics) {
          const now = Date.now();

          if (pushingRef.current) {
            if (!sessionRef.current) {
              sessionRef.current = { startTs: now, perDest: {} };
            }
            for (const relay of event.relays) {
              const existing = sessionRef.current.perDest[relay.destinationId] ?? {
                sumKbps: 0,
                count: 0,
                maxKbps: 0,
                lastKbps: 0,
              };
              const nextCount = existing.count + 1;
              const nextSum = existing.sumKbps + relay.bitrateKbps;
              const nextMax = Math.max(existing.maxKbps, relay.bitrateKbps);
              sessionRef.current.perDest[relay.destinationId] = {
                sumKbps: nextSum,
                count: nextCount,
                maxKbps: nextMax,
                lastKbps: relay.bitrateKbps,
              };
            }
          }

          setBitrateSeries((prev) => {
            const next: BitrateSeries = { ...prev };
            for (const relay of event.relays) {
              const points = next[relay.destinationId]
                ? [...next[relay.destinationId]]
                : [];
              points.push({ t: now, kbps: relay.bitrateKbps });
              next[relay.destinationId] =
                points.length > MAX_BITRATE_POINTS
                  ? points.slice(points.length - MAX_BITRATE_POINTS)
                  : points;
            }
            return next;
          });
        }
        break;

      case "debug_log":
        pushDebugLog(event.source, event.message, "info", event.timestamp);
        break;

      case "sidecar_error":
        pushDebugLog("sidecar", event.error, "error");
        break;

      case "server_error":
        pushDebugLog("server", event.error, "error");
        break;

      case "error":
        pushDebugLog("sidecar", event.error, "error");
        break;
    }
  }, [pushDebugLog]);

  useEffect(() => {
    const unlistenPromise = api.onSidecarEvent(handleSidecarEvent);

    const timer = setTimeout(() => {
      api.getStatus().catch(console.error);
    }, 1000);

    return () => {
      clearTimeout(timer);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [handleSidecarEvent]);

  useEffect(() => {
    const prev = pushingPrevRef.current;
    const next = status.pushing;

    if (!prev && next) {
      sessionRef.current = { startTs: Date.now(), perDest: {} };
    } else if (prev && !next) {
      const endTs = Date.now();
      const session = sessionRef.current;
      if (featureFlags.analytics && session) {
        const perDest: SessionSummary["perDest"] = {};
        for (const [destId, acc] of Object.entries(session.perDest)) {
          perDest[destId] = {
            avgKbps: acc.count ? Math.round(acc.sumKbps / acc.count) : 0,
            maxKbps: acc.maxKbps,
            samples: acc.count,
          };
        }

        const restarts: SessionSummary["restarts"] = {};
        const errors: SessionSummary["errors"] = {};
        for (const r of status.relays) {
          restarts[r.destinationId] = r.restartCount;
          errors[r.destinationId] = r.error;
        }

        setLastSession({
          startTs: session.startTs,
          endTs,
          durationMs: Math.max(0, endTs - session.startTs),
          perDest,
          restarts,
          errors,
        });
      }
      sessionRef.current = null;
    }

    pushingPrevRef.current = next;
  }, [status.pushing, status.relays]);

  function openDoctorForDestination(destinationId: string) {
    const dest = status.destinations.find((d) => d.id === destinationId);
    if (!dest) return;
    setDoctorContext(dest);
    setDoctorOpen(true);
  }

  async function handleStartServer() {
    try {
      await api.startServer(status.port);
    } catch (e) {
      const msg = `Failed to start server on port ${status.port}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleStopServer() {
    try {
      await api.stopServer();
    } catch (e) {
      const msg = `Failed to stop server: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handlePushDestinations() {
    try {
      await api.pushDestinations();
    } catch (e) {
      const msg = `Failed to push destinations: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleStopPushing() {
    try {
      await api.stopPushing();
    } catch (e) {
      const msg = `Failed to stop pushing: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleAddDestination(dest: Destination) {
    try {
      await api.addDestination(dest);
    } catch (e) {
      const msg = `Failed to add destination ${dest.name}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleUpdateDestination(dest: Destination) {
    try {
      await api.updateDestination(dest);
    } catch (e) {
      const msg = `Failed to update destination ${dest.name}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleRemoveDestination(id: string) {
    try {
      await api.removeDestination(id);
    } catch (e) {
      const msg = `Failed to remove destination ${id}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handlePortChange(port: number) {
    setStatus((prev) => ({ ...prev, port }));
    if (status.serverRunning) {
      await api.stopServer().catch((e) => {
        const msg = `Failed to stop server before port change: ${toErrorMessage(e)}`;
        console.error(msg, e);
        pushDebugLog("ui", msg, "error");
      });
      await api.startServer(port).catch((e) => {
        const msg = `Failed to restart server on port ${port}: ${toErrorMessage(e)}`;
        console.error(msg, e);
        pushDebugLog("ui", msg, "error");
      });
    }
  }

  async function handleDebugModeChange(enabled: boolean) {
    setStatus((prev) => ({ ...prev, debugMode: enabled }));
    try {
      await api.setDebugMode(enabled);
    } catch (e) {
      const msg = `Failed to set debug mode to ${enabled}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleCheckUpdates() {
    const message = await api.checkForUpdates();
    alert(message);
  }

  return (
    <>
      <Layout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        debugMode={status.debugMode}
        debugLogs={debugLogs}
        onClearDebugLogs={() => setDebugLogs([])}
      >
        {activeTab === "dashboard" && (
          <Dashboard
            status={status}
            onStartServer={handleStartServer}
            onStopServer={handleStopServer}
            onPushDestinations={handlePushDestinations}
            onStopPushing={handleStopPushing}
            onRefresh={() => api.getStatus().catch(console.error)}
            featureFlags={featureFlags}
            onOpenConnectionDoctor={
              featureFlags.reliabilitySuite ? openDoctorForDestination : undefined
            }
            bitrateSeries={featureFlags.analytics ? bitrateSeries : undefined}
            lastSession={featureFlags.analytics ? lastSession : undefined}
          />
        )}
        {activeTab === "destinations" && (
          <DestinationsPanel
            destinations={status.destinations}
            relays={status.relays}
            onAdd={handleAddDestination}
            onUpdate={handleUpdateDestination}
            onRemove={handleRemoveDestination}
            featureFlags={featureFlags}
          />
        )}
        {activeTab === "settings" && (
          <SettingsPanel
            port={status.port}
            autoStart={autoStart}
            debugMode={status.debugMode}
            onPortChange={handlePortChange}
            onAutoStartChange={setAutoStart}
            onDebugModeChange={handleDebugModeChange}
            onCheckUpdates={handleCheckUpdates}
          />
        )}
      </Layout>

      {featureFlags.reliabilitySuite && doctorContext ? (
        <ConnectionDoctor
          open={doctorOpen}
          onOpenChange={setDoctorOpen}
          platform={doctorContext.platform}
          url={doctorContext.url}
          streamKey={doctorContext.streamKey}
        />
      ) : null}
    </>
  );
}
