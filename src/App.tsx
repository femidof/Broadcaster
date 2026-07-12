import { useState, useEffect, useCallback, useRef } from "react";
import { Layout, type TabId } from "@/components/layout";
import { Dashboard } from "@/components/dashboard";
import { DestinationsPanel } from "@/components/destinations-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { ProfileBar } from "@/components/profile-bar";
import { type DebugLogEntry } from "@/components/debug-panel";
import type {
  AppStatus,
  Destination,
  Profile,
  ProfileStatus,
  SidecarEvent,
  StreamFallbackSlate,
} from "@/lib/types";
import * as api from "@/lib/tauri";
import { featureFlags } from "@/lib/feature-flags";
import { ConnectionDoctor } from "@/components/reliability/connection-doctor";

const MAX_DEBUG_LOGS = 500;
const MAX_BITRATE_POINTS = 300;

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

/** Matches sidecar `config-store` default profile until first `status` event. */
const DEFAULT_INITIAL_PROFILE_STATUS: ProfileStatus = {
  profileId: "default",
  profileName: "Default",
  port: 1935,
  autoStart: false,
  serverRunning: false,
  streamActive: false,
  pushing: false,
  slateActive: false,
  relays: [],
  destinations: [],
};

const DEFAULT_APP_STATUS: AppStatus = {
  profiles: [DEFAULT_INITIAL_PROFILE_STATUS],
  debugMode: false,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function profileStatusToProfile(p: ProfileStatus): Profile {
  const base: Profile = {
    id: p.profileId,
    name: p.profileName,
    port: p.port,
    autoStart: p.autoStart,
    destinations: p.destinations.map((d) => ({ ...d })),
  };
  if (p.streamFallbackSlate !== undefined) {
    base.streamFallbackSlate = { ...p.streamFallbackSlate };
  }
  return base;
}

function bitrateKey(profileId: string, destinationId: string): string {
  return `${profileId}:${destinationId}`;
}

function effectiveProfileId(
  profiles: ProfileStatus[],
  selected: string | null
): string | null {
  if (profiles.length === 0) return null;
  if (selected != null && profiles.some((p) => p.profileId === selected)) {
    return selected;
  }
  return profiles[0].profileId;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [appStatus, setAppStatus] = useState<AppStatus>(DEFAULT_APP_STATUS);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const logIdRef = useRef(0);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorContext, setDoctorContext] = useState<Destination | null>(null);
  const [bitrateSeries, setBitrateSeries] = useState<BitrateSeries>({});
  const pushingRef = useRef(false);
  const sessionRef = useRef<SessionAccum | null>(null);
  const pushingPrevRef = useRef(false);
  const [lastSession, setLastSession] = useState<SessionSummary | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const effectiveSelectedProfileId = effectiveProfileId(
    appStatus.profiles,
    selectedProfileId
  );

  const selectedProfile =
    appStatus.profiles.find((p) => p.profileId === effectiveSelectedProfileId) ??
    null;

  useEffect(() => {
    selectedIdRef.current = effectiveSelectedProfileId;
  }, [effectiveSelectedProfileId]);

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

  const mergeRelayUpdate = useCallback(
    (
      profileId: string,
      destinationId: string,
      fn: (r: ProfileStatus["relays"][number]) => ProfileStatus["relays"][number]
    ) => {
      setAppStatus((prev) => ({
        ...prev,
        profiles: prev.profiles.map((p) => {
          if (p.profileId !== profileId) return p;
          return {
            ...p,
            relays: p.relays.map((r) =>
              r.destinationId === destinationId ? fn(r) : r
            ),
          };
        }),
      }));
    },
    []
  );

  const handleSidecarEvent = useCallback(
    (event: SidecarEvent) => {
      switch (event.event) {
        case "ready":
          api.getStatus().catch(console.error);
          break;

        case "server_started":
          setAppStatus((prev) => ({
            ...prev,
            profiles: prev.profiles.map((p) =>
              p.profileId === event.profileId
                ? { ...p, serverRunning: true, port: event.port }
                : p
            ),
          }));
          break;

        case "server_stopped":
          setAppStatus((prev) => ({
            ...prev,
            profiles: prev.profiles.map((p) =>
              p.profileId === event.profileId
                ? {
                    ...p,
                    serverRunning: false,
                    streamActive: false,
                    slateActive: false,
                    pushing: false,
                    relays: p.relays.map((r) => ({
                      ...r,
                      status: "idle" as const,
                      bitrateKbps: 0,
                    })),
                  }
                : p
            ),
          }));
          break;

        case "all_servers_stopped":
          setAppStatus((prev) => ({
            ...prev,
            profiles: prev.profiles.map((p) => ({
              ...p,
              serverRunning: false,
              streamActive: false,
              slateActive: false,
              pushing: false,
              relays: p.relays.map((r) => ({
                ...r,
                status: "idle" as const,
                bitrateKbps: 0,
              })),
            })),
          }));
          break;

        case "stream_connected":
          void api.getStatus();
          break;

        case "stream_disconnected":
          void api.getStatus();
          break;

        case "relay_started":
          mergeRelayUpdate(event.profileId, event.destinationId, (r) => ({
            ...r,
            status: "live" as const,
            error: undefined,
          }));
          break;

        case "relay_stopped":
          mergeRelayUpdate(event.profileId, event.destinationId, (r) => ({
            ...r,
            status: "idle" as const,
            bitrateKbps: 0,
          }));
          break;

        case "relay_error":
          mergeRelayUpdate(event.profileId, event.destinationId, (r) => ({
            ...r,
            status: "error" as const,
            error: event.error,
            bitrateKbps: 0,
          }));
          break;

        case "status": {
          const sel = selectedIdRef.current;
          const sp = event.profiles.find((p) => p.profileId === sel);
          pushingRef.current = sp?.pushing ?? false;
          setAppStatus({
            profiles: event.profiles.map((p) => ({ ...p, destinations: [...p.destinations] })),
            debugMode: event.debugMode,
          });
          break;
        }

        case "destinations_updated":
          setAppStatus((prev) => ({
            ...prev,
            profiles: prev.profiles.map((p) =>
              p.profileId === event.profileId
                ? { ...p, destinations: [...event.destinations] }
                : p
            ),
          }));
          break;

        case "relay_stats": {
          const now = Date.now();
          const pid = event.profileId;
          let wasPushing = false;
          setAppStatus((prev) => {
            wasPushing =
              prev.profiles.find((p) => p.profileId === pid)?.pushing ?? false;
            if (featureFlags.analytics && wasPushing) {
              if (!sessionRef.current) {
                sessionRef.current = { startTs: now, perDest: {} };
              }
              for (const relay of event.relays) {
                const key = relay.destinationId;
                const existing = sessionRef.current.perDest[key] ?? {
                  sumKbps: 0,
                  count: 0,
                  maxKbps: 0,
                  lastKbps: 0,
                };
                sessionRef.current.perDest[key] = {
                  sumKbps: existing.sumKbps + relay.bitrateKbps,
                  count: existing.count + 1,
                  maxKbps: Math.max(existing.maxKbps, relay.bitrateKbps),
                  lastKbps: relay.bitrateKbps,
                };
              }
            }
            return {
              ...prev,
              profiles: prev.profiles.map((p) => {
                if (p.profileId !== pid) return p;
                return {
                  ...p,
                  relays: event.relays.map((u) => {
                    const existing = p.relays.find(
                      (r) => r.destinationId === u.destinationId
                    );
                    return existing
                      ? { ...existing, bitrateKbps: u.bitrateKbps }
                      : u;
                  }),
                };
              }),
            };
          });
          if (featureFlags.analytics && wasPushing) {
            setBitrateSeries((prev) => {
              const next = { ...prev };
              for (const relay of event.relays) {
                const bk = bitrateKey(pid, relay.destinationId);
                const points = next[bk] ? [...next[bk]] : [];
                points.push({ t: now, kbps: relay.bitrateKbps });
                next[bk] =
                  points.length > MAX_BITRATE_POINTS
                    ? points.slice(points.length - MAX_BITRATE_POINTS)
                    : points;
              }
              return next;
            });
          }
          break;
        }

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
    },
    [mergeRelayUpdate, pushDebugLog]
  );

  useEffect(() => {
    const unlistenPromise = api.onSidecarEvent(handleSidecarEvent);
    void api.getStatus().catch(console.error);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [handleSidecarEvent]);

  const selectedPushing = selectedProfile?.pushing ?? false;

  useEffect(() => {
    const prev = pushingPrevRef.current;
    const next = selectedPushing;
    const relays = selectedProfile?.relays ?? [];

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
        for (const r of relays) {
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
  }, [selectedPushing, selectedProfile]);

  function openDoctorForDestination(destinationId: string) {
    const dest = selectedProfile?.destinations.find((d) => d.id === destinationId);
    if (!dest) return;
    setDoctorContext(dest);
    setDoctorOpen(true);
  }

  async function handleStartServer() {
    if (!selectedProfile) return;
    try {
      await api.startServer(selectedProfile.profileId);
    } catch (e) {
      const msg = `Failed to start server: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleStopServer() {
    if (!selectedProfile) return;
    try {
      await api.stopServer(selectedProfile.profileId);
    } catch (e) {
      const msg = `Failed to stop server: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handlePushDestinations() {
    if (!selectedProfile) return;
    try {
      await api.pushDestinations(selectedProfile.profileId);
    } catch (e) {
      const msg = `Failed to push destinations: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleStopPushing() {
    if (!selectedProfile) return;
    try {
      await api.stopPushing(selectedProfile.profileId);
    } catch (e) {
      const msg = `Failed to stop pushing: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleAddDestination(dest: Destination) {
    if (!selectedProfile) return;
    try {
      await api.addDestination(selectedProfile.profileId, dest);
    } catch (e) {
      const msg = `Failed to add destination ${dest.name}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleUpdateDestination(dest: Destination) {
    if (!selectedProfile) return;
    try {
      await api.updateDestination(selectedProfile.profileId, dest);
    } catch (e) {
      const msg = `Failed to update destination ${dest.name}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleRemoveDestination(id: string) {
    if (!selectedProfile) return;
    try {
      await api.removeDestination(selectedProfile.profileId, id);
    } catch (e) {
      const msg = `Failed to remove destination ${id}: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handlePortChange(port: number) {
    if (!selectedProfile) return;
    const next = profileStatusToProfile({ ...selectedProfile, port });
    try {
      if (selectedProfile.serverRunning) {
        await api.stopServer(selectedProfile.profileId);
        await api.updateProfile(next);
        await api.startServer(selectedProfile.profileId);
      } else {
        await api.updateProfile(next);
      }
    } catch (e) {
      const msg = `Failed to update port: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleStreamFallbackSlateChange(slate: StreamFallbackSlate): Promise<void> {
    if (!selectedProfile) return;
    try {
      await api.updateProfile(
        profileStatusToProfile({ ...selectedProfile, streamFallbackSlate: slate })
      );
    } catch (e) {
      const msg = `Failed to update stream fallback: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
      throw e;
    }
  }

  async function handleProfileNameChange(name: string) {
    if (!selectedProfile) return;
    try {
      await api.updateProfile(
        profileStatusToProfile({ ...selectedProfile, profileName: name })
      );
    } catch (e) {
      const msg = `Failed to rename profile: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleAutoStartChange(autoStart: boolean) {
    if (!selectedProfile) return;
    try {
      await api.updateProfile(profileStatusToProfile({ ...selectedProfile, autoStart }));
    } catch (e) {
      const msg = `Failed to update auto-start: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleCreateProfile(name: string, port: number) {
    const id = crypto.randomUUID();
    try {
      await api.createProfile({
        id,
        name,
        port,
        autoStart: false,
        destinations: [],
      });
      setSelectedProfileId(id);
    } catch (e) {
      const msg = `Failed to create profile: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleDeleteProfile() {
    if (!selectedProfile || appStatus.profiles.length <= 1) return;
    if (!confirm(`Delete profile "${selectedProfile.profileName}"? This cannot be undone.`)) {
      return;
    }
    try {
      await api.deleteProfile(selectedProfile.profileId);
    } catch (e) {
      const msg = `Failed to delete profile: ${toErrorMessage(e)}`;
      console.error(msg, e);
      pushDebugLog("ui", msg, "error");
    }
  }

  async function handleDebugModeChange(enabled: boolean) {
    setAppStatus((prev) => ({ ...prev, debugMode: enabled }));
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

  const dashboardStatus = selectedProfile
    ? {
        serverRunning: selectedProfile.serverRunning,
        port: selectedProfile.port,
        streamActive: selectedProfile.streamActive,
        pushing: selectedProfile.pushing,
        slateActive: selectedProfile.slateActive,
        relays: selectedProfile.relays,
        destinations: selectedProfile.destinations,
      }
    : {
        serverRunning: false,
        port: 1935,
        streamActive: false,
        pushing: false,
        slateActive: false,
        relays: [],
        destinations: [],
      };

  const analyticsBitrateSeries =
    featureFlags.analytics && selectedProfile
      ? Object.fromEntries(
          Object.entries(bitrateSeries)
            .filter(([k]) => k.startsWith(`${selectedProfile.profileId}:`))
            .map(([k, v]) => [k.split(":")[1] ?? k, v])
        )
      : undefined;

  return (
    <>
      <Layout
        activeTab={activeTab}
        onTabChange={setActiveTab}
        profileBar={
          <ProfileBar
            profiles={appStatus.profiles}
            selectedId={effectiveSelectedProfileId}
            onSelect={setSelectedProfileId}
            onCreateProfile={handleCreateProfile}
          />
        }
        debugMode={appStatus.debugMode}
        debugLogs={debugLogs}
        onClearDebugLogs={() => setDebugLogs([])}
      >
        {activeTab === "dashboard" && (
          <Dashboard
            status={dashboardStatus}
            onStartServer={handleStartServer}
            onStopServer={handleStopServer}
            onPushDestinations={handlePushDestinations}
            onStopPushing={handleStopPushing}
            onRefresh={() => api.getStatus().catch(console.error)}
            featureFlags={featureFlags}
            onOpenConnectionDoctor={
              featureFlags.reliabilitySuite ? openDoctorForDestination : undefined
            }
            bitrateSeries={analyticsBitrateSeries}
            lastSession={featureFlags.analytics ? lastSession : undefined}
          />
        )}
        {activeTab === "destinations" && (
          <DestinationsPanel
            destinations={selectedProfile?.destinations ?? []}
            relays={selectedProfile?.relays ?? []}
            onAdd={handleAddDestination}
            onUpdate={handleUpdateDestination}
            onRemove={handleRemoveDestination}
            featureFlags={featureFlags}
          />
        )}
        {activeTab === "settings" && (
          <SettingsPanel
            selectedProfile={selectedProfile}
            canDeleteProfile={appStatus.profiles.length > 1}
            onProfileNameChange={handleProfileNameChange}
            onPortChange={handlePortChange}
            onAutoStartChange={handleAutoStartChange}
            onDeleteProfile={handleDeleteProfile}
            onStreamFallbackSlateChange={handleStreamFallbackSlateChange}
            debugMode={appStatus.debugMode}
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
