import { useState, useEffect, useCallback, useRef } from "react";
import { Layout, type TabId } from "@/components/layout";
import { Dashboard } from "@/components/dashboard";
import { DestinationsPanel } from "@/components/destinations-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { type DebugLogEntry } from "@/components/debug-panel";
import type { AppStatus, Destination, SidecarEvent } from "@/lib/types";
import * as api from "@/lib/tauri";

const MAX_DEBUG_LOGS = 500;

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
        />
      )}
      {activeTab === "destinations" && (
        <DestinationsPanel
          destinations={status.destinations}
          relays={status.relays}
          onAdd={handleAddDestination}
          onUpdate={handleUpdateDestination}
          onRemove={handleRemoveDestination}
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
  );
}
