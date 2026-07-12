import * as readline from "readline";
import { RtmpServer } from "./rtmp-server";
import { RelayManager } from "./relay-manager";
import { ConfigStore } from "./config-store";
import type { InboundCommand, OutboundEvent, ProfileStatus } from "./types";

function emit(event: OutboundEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function parseArgs(): { dataDir: string } {
  const args = process.argv.slice(2);
  let dataDir = "./data";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) {
      dataDir = args[++i];
    }
  }

  return { dataDir };
}

function emitDebugLog(source: string, message: string): void {
  emit({ event: "debug_log", source, message, timestamp: Date.now() });
}

type ProfileInstance = {
  rtmpServer: RtmpServer | null;
  relayManager: RelayManager;
  statsInterval: ReturnType<typeof setInterval> | null;
};

function main(): void {
  const { dataDir } = parseArgs();
  const config = new ConfigStore(dataDir);

  process.on("uncaughtException", (err) => {
    emitDebugLog("sidecar", `Uncaught exception: ${err.message}\n${err.stack ?? ""}`);
    emit({ event: "error", error: `Uncaught exception: ${err.message}` });
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    emitDebugLog("sidecar", `Unhandled rejection: ${msg}`);
  });

  const instances = new Map<string, ProfileInstance>();

  function initRelayManager(profileId: string, port: number): RelayManager {
    const rm = new RelayManager(port, {
      onRelayStarted: (destinationId) => {
        emit({ event: "relay_started", profileId, destinationId });
      },
      onRelayStopped: (destinationId, reason) => {
        emit({ event: "relay_stopped", profileId, destinationId, reason });
      },
      onRelayError: (destinationId, error) => {
        emit({ event: "relay_error", profileId, destinationId, error });
      },
      onDebugLog: (source, message) => {
        if (config.getDebugMode()) {
          emitDebugLog(source, message);
        }
      },
    });

    const profile = config.getProfile(profileId);
    if (profile) {
      for (const dest of profile.destinations) {
        rm.addDestination(dest);
      }
      rm.setStreamFallbackSlate(profile.streamFallbackSlate);
    }

    return rm;
  }

  function getOrCreateInstance(profileId: string): ProfileInstance | null {
    const existing = instances.get(profileId);
    if (existing) return existing;
    const profile = config.getProfile(profileId);
    if (!profile) return null;
    const relayManager = initRelayManager(profileId, profile.port);
    const inst: ProfileInstance = {
      rtmpServer: null,
      relayManager,
      statsInterval: null,
    };
    instances.set(profileId, inst);
    return inst;
  }

  function stopStatsInterval(profileId: string): void {
    const inst = instances.get(profileId);
    if (inst?.statsInterval) {
      clearInterval(inst.statsInterval);
      inst.statsInterval = null;
    }
  }

  function startStatsInterval(profileId: string): void {
    stopStatsInterval(profileId);
    const inst = instances.get(profileId);
    if (!inst) return;
    inst.statsInterval = setInterval(() => {
      const i = instances.get(profileId);
      if (i?.relayManager.isPushing()) {
        i.relayManager.updateStats();
        emit({
          event: "relay_stats",
          profileId,
          relays: i.relayManager.getStatuses(),
        });
      }
    }, 2000);
  }

  function syncRelayManagerWithConfig(profileId: string): void {
    const inst = instances.get(profileId);
    const profile = config.getProfile(profileId);
    if (!inst || !profile) return;

    inst.relayManager.setIngestPort(profile.port);
    inst.relayManager.setStreamFallbackSlate(profile.streamFallbackSlate);
    const known = new Set(
      inst.relayManager.getStatuses().map((s) => s.destinationId)
    );
    const nextIds = new Set(profile.destinations.map((d) => d.id));

    for (const dest of profile.destinations) {
      if (known.has(dest.id)) {
        inst.relayManager.updateDestination(dest);
      } else {
        inst.relayManager.addDestination(dest);
      }
    }
    for (const id of known) {
      if (!nextIds.has(id)) {
        inst.relayManager.removeDestination(id);
      }
    }
  }

  function startServer(profileId: string): void {
    const profile = config.getProfile(profileId);
    if (!profile) {
      emit({
        event: "server_error",
        profileId,
        error: "Unknown profile",
      });
      return;
    }

    let inst = instances.get(profileId);
    if (inst?.rtmpServer?.isRunning()) {
      inst.rtmpServer.stop();
    }
    if (inst) {
      inst.relayManager.stopAll();
      stopStatsInterval(profileId);
    }

    const relayManager = initRelayManager(profileId, profile.port);
    const newInst: ProfileInstance = {
      rtmpServer: null,
      relayManager,
      statsInterval: null,
    };
    instances.set(profileId, newInst);
    inst = newInst;

    const rtmpServer = new RtmpServer(profile.port, {
      onStreamConnect: (streamKey) => {
        emit({ event: "stream_connected", profileId, streamKey });
        instances.get(profileId)?.relayManager.onStreamConnect(streamKey);
        emitStatus();
      },
      onStreamDisconnect: (streamKey) => {
        emit({ event: "stream_disconnected", profileId, streamKey });
        instances.get(profileId)?.relayManager.onStreamDisconnect(streamKey);
        emitStatus();
      },
      onDebugLog: (source, message) => {
        if (config.getDebugMode()) {
          emitDebugLog(source, message);
        }
      },
    });

    inst.rtmpServer = rtmpServer;

    try {
      rtmpServer.start();
      emit({ event: "server_started", profileId, port: profile.port });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ event: "server_error", profileId, error: msg });
    }
  }

  function stopServer(profileId: string): void {
    const inst = instances.get(profileId);
    if (!inst) return;
    stopStatsInterval(profileId);
    inst.relayManager.stopAll();
    if (inst.rtmpServer?.isRunning()) {
      inst.rtmpServer.stop();
      emit({ event: "server_stopped", profileId });
    }
    inst.rtmpServer = null;
  }

  function buildProfileStatus(profileId: string): ProfileStatus | null {
    const profile = config.getProfile(profileId);
    if (!profile) return null;
    const inst = instances.get(profileId);
    const serverRunning = inst?.rtmpServer?.isRunning() ?? false;
    const streamActive = inst?.rtmpServer?.hasActiveStream() ?? false;
    const slateActive = inst?.relayManager.isSlateFallbackActive() ?? false;
    const status: ProfileStatus = {
      profileId: profile.id,
      profileName: profile.name,
      port: profile.port,
      autoStart: profile.autoStart,
      serverRunning,
      streamActive,
      pushing: inst?.relayManager.isPushing() ?? false,
      slateActive,
      relays: inst?.relayManager.getStatuses() ?? [],
      destinations: [...profile.destinations],
    };
    if (profile.streamFallbackSlate !== undefined) {
      status.streamFallbackSlate = { ...profile.streamFallbackSlate };
    }
    return status;
  }

  function emitStatus(): void {
    const profiles: ProfileStatus[] = [];
    for (const p of config.getProfiles()) {
      const s = buildProfileStatus(p.id);
      if (s) profiles.push(s);
    }
    emit({
      event: "status",
      profiles,
      debugMode: config.getDebugMode(),
    });
  }

  function handleCommand(cmd: InboundCommand): void {
    switch (cmd.cmd) {
      case "create_profile": {
        config.addProfile(cmd.profile);
        getOrCreateInstance(cmd.profile.id);
        emitStatus();
        break;
      }

      case "update_profile": {
        const prev = config.getProfile(cmd.profile.id);
        const portChanged = prev && prev.port !== cmd.profile.port;
        config.updateProfile(cmd.profile);
        const inst = getOrCreateInstance(cmd.profile.id);
        if (inst) {
          if (inst.rtmpServer?.isRunning() && portChanged) {
            stopServer(cmd.profile.id);
            startServer(cmd.profile.id);
          } else {
            syncRelayManagerWithConfig(cmd.profile.id);
          }
        }
        emitStatus();
        break;
      }

      case "delete_profile": {
        if (!config.removeProfile(cmd.profileId)) {
          emit({
            event: "error",
            error: "Cannot delete the last profile",
          });
          break;
        }
        stopStatsInterval(cmd.profileId);
        const inst = instances.get(cmd.profileId);
        if (inst?.rtmpServer?.isRunning()) {
          inst.rtmpServer.stop();
        }
        instances.delete(cmd.profileId);
        emitStatus();
        break;
      }

      case "start_server":
        startServer(cmd.profileId);
        emitStatus();
        break;

      case "stop_server":
        stopServer(cmd.profileId);
        emitStatus();
        break;

      case "add_destination":
        config.addDestination(cmd.profileId, cmd.destination);
        {
          const inst = getOrCreateInstance(cmd.profileId);
          if (inst) inst.relayManager.addDestination(cmd.destination);
        }
        emit({
          event: "destinations_updated",
          profileId: cmd.profileId,
          destinations: config.getProfile(cmd.profileId)?.destinations ?? [],
        });
        emitStatus();
        break;

      case "remove_destination":
        config.removeDestination(cmd.profileId, cmd.id);
        {
          const inst = instances.get(cmd.profileId);
          inst?.relayManager.removeDestination(cmd.id);
        }
        emit({
          event: "destinations_updated",
          profileId: cmd.profileId,
          destinations: config.getProfile(cmd.profileId)?.destinations ?? [],
        });
        emitStatus();
        break;

      case "update_destination":
        config.updateDestination(cmd.profileId, cmd.destination);
        {
          const inst = instances.get(cmd.profileId);
          inst?.relayManager.updateDestination(cmd.destination);
        }
        emit({
          event: "destinations_updated",
          profileId: cmd.profileId,
          destinations: config.getProfile(cmd.profileId)?.destinations ?? [],
        });
        emitStatus();
        break;

      case "push_destinations": {
        const inst = getOrCreateInstance(cmd.profileId);
        if (inst) {
          inst.relayManager.pushDestinations();
          startStatsInterval(cmd.profileId);
        }
        emitStatus();
        break;
      }

      case "stop_pushing": {
        const inst = instances.get(cmd.profileId);
        inst?.relayManager.stopPushing();
        stopStatsInterval(cmd.profileId);
        emitStatus();
        break;
      }

      case "get_status":
        emitStatus();
        break;

      case "set_debug_mode":
        config.setDebugMode(cmd.enabled);
        emitDebugLog("sidecar", `Debug mode ${cmd.enabled ? "enabled" : "disabled"}`);
        emitStatus();
        break;

      case "shutdown": {
        for (const id of [...instances.keys()]) {
          stopStatsInterval(id);
          const inst = instances.get(id);
          inst?.relayManager.stopAll();
          if (inst?.rtmpServer?.isRunning()) {
            inst.rtmpServer.stop();
          }
        }
        instances.clear();
        process.exit(0);
      }
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line) => {
    try {
      const cmd: InboundCommand = JSON.parse(line.trim());
      handleCommand(cmd);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[sidecar] Invalid command:", line, error);
      emit({ event: "error", error: `Invalid command: ${line}` });
    }
  });

  rl.on("close", () => {
    for (const id of [...instances.keys()]) {
      stopStatsInterval(id);
      const inst = instances.get(id);
      inst?.relayManager.stopAll();
      if (inst?.rtmpServer?.isRunning()) {
        inst.rtmpServer.stop();
      }
    }
    instances.clear();
    process.exit(0);
  });

  for (const p of config.getProfiles()) {
    getOrCreateInstance(p.id);
    if (p.autoStart) {
      startServer(p.id);
    }
  }

  emit({ event: "ready" });
}

main();
