import { useState, useEffect, useCallback } from "react";
import { Layout, type TabId } from "@/components/layout";
import { Dashboard } from "@/components/dashboard";
import { DestinationsPanel } from "@/components/destinations-panel";
import { SettingsPanel } from "@/components/settings-panel";
import type { AppStatus, Destination, SidecarEvent } from "@/lib/types";
import * as api from "@/lib/tauri";

const DEFAULT_STATUS: AppStatus = {
  serverRunning: false,
  port: 1935,
  streamActive: false,
  relays: [],
  destinations: [],
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [status, setStatus] = useState<AppStatus>(DEFAULT_STATUS);
  const [autoStart, setAutoStart] = useState(true);

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
          relays: prev.relays.map((r) => ({ ...r, status: "idle" as const })),
        }));
        break;

      case "stream_connected":
        setStatus((prev) => ({ ...prev, streamActive: true }));
        break;

      case "stream_disconnected":
        setStatus((prev) => ({
          ...prev,
          streamActive: false,
          relays: prev.relays.map((r) => ({ ...r, status: "idle" as const })),
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
              ? { ...r, status: "idle" as const }
              : r
          ),
        }));
        break;

      case "relay_error":
        setStatus((prev) => ({
          ...prev,
          relays: prev.relays.map((r) =>
            r.destinationId === event.destinationId
              ? { ...r, status: "error" as const, error: event.error }
              : r
          ),
        }));
        break;

      case "status":
        setStatus({
          serverRunning: event.serverRunning,
          port: event.port,
          streamActive: event.streamActive,
          relays: event.relays,
          destinations: event.destinations,
        });
        break;

      case "destinations_updated":
        setStatus((prev) => ({
          ...prev,
          destinations: event.destinations,
        }));
        break;

      case "server_error":
        console.error("Server error:", event.error);
        break;

      case "error":
        console.error("Sidecar error:", event.error);
        break;
    }
  }, []);

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
      console.error("Failed to start server:", e);
    }
  }

  async function handleStopServer() {
    try {
      await api.stopServer();
    } catch (e) {
      console.error("Failed to stop server:", e);
    }
  }

  async function handleAddDestination(dest: Destination) {
    try {
      await api.addDestination(dest);
    } catch (e) {
      console.error("Failed to add destination:", e);
    }
  }

  async function handleUpdateDestination(dest: Destination) {
    try {
      await api.updateDestination(dest);
    } catch (e) {
      console.error("Failed to update destination:", e);
    }
  }

  async function handleRemoveDestination(id: string) {
    try {
      await api.removeDestination(id);
    } catch (e) {
      console.error("Failed to remove destination:", e);
    }
  }

  async function handlePortChange(port: number) {
    setStatus((prev) => ({ ...prev, port }));
    if (status.serverRunning) {
      await api.stopServer().catch(console.error);
      await api.startServer(port).catch(console.error);
    }
  }

  async function handleCheckUpdates() {
    const message = await api.checkForUpdates();
    alert(message);
  }

  return (
    <Layout activeTab={activeTab} onTabChange={setActiveTab}>
      {activeTab === "dashboard" && (
        <Dashboard
          status={status}
          onStartServer={handleStartServer}
          onStopServer={handleStopServer}
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
          onPortChange={handlePortChange}
          onAutoStartChange={setAutoStart}
          onCheckUpdates={handleCheckUpdates}
        />
      )}
    </Layout>
  );
}
