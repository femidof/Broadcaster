import * as readline from "readline";
import { RtmpServer } from "./rtmp-server";
import { RelayManager } from "./relay-manager";
import { ConfigStore } from "./config-store";
import { InboundCommand, OutboundEvent } from "./types";

function emit(event: OutboundEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function parseArgs(): { ffmpegPath: string; dataDir: string } {
  const args = process.argv.slice(2);
  let ffmpegPath = "ffmpeg";
  let dataDir = "./data";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ffmpeg-path" && args[i + 1]) {
      ffmpegPath = args[++i];
    } else if (args[i] === "--data-dir" && args[i + 1]) {
      dataDir = args[++i];
    }
  }

  return { ffmpegPath, dataDir };
}

function emitDebugLog(source: string, message: string): void {
  emit({ event: "debug_log", source, message, timestamp: Date.now() });
}

function main(): void {
  const { ffmpegPath, dataDir } = parseArgs();
  const config = new ConfigStore(dataDir);

  process.on("uncaughtException", (err) => {
    emitDebugLog("sidecar", `Uncaught exception: ${err.message}\n${err.stack ?? ""}`);
    emit({ event: "error", error: `Uncaught exception: ${err.message}` });
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    emitDebugLog("sidecar", `Unhandled rejection: ${msg}`);
  });

  let rtmpServer: RtmpServer | null = null;
  let relayManager: RelayManager | null = null;

  function initRelayManager(): RelayManager {
    const rm = new RelayManager(ffmpegPath, config.getPort(), {
      onRelayStarted: (destinationId) => {
        emit({ event: "relay_started", destinationId });
      },
      onRelayStopped: (destinationId, reason) => {
        emit({ event: "relay_stopped", destinationId, reason });
      },
      onRelayError: (destinationId, error) => {
        emit({ event: "relay_error", destinationId, error });
      },
      onDebugLog: (source, message) => {
        if (config.getDebugMode()) {
          emitDebugLog(source, message);
        }
      },
    });

    for (const dest of config.getDestinations()) {
      rm.addDestination(dest);
    }

    return rm;
  }

  function startServer(port: number): void {
    if (rtmpServer?.isRunning()) {
      rtmpServer.stop();
    }

    relayManager?.stopAll();

    config.setPort(port);
    relayManager = initRelayManager();

    rtmpServer = new RtmpServer(port, {
      onStreamConnect: (streamKey) => {
        emit({ event: "stream_connected", streamKey });
        relayManager?.onStreamConnect(streamKey);
      },
      onStreamDisconnect: (streamKey) => {
        emit({ event: "stream_disconnected", streamKey });
        relayManager?.onStreamDisconnect(streamKey);
      },
      onDebugLog: (source, message) => {
        if (config.getDebugMode()) {
          emitDebugLog(source, message);
        }
      },
    });

    try {
      rtmpServer.start();
      emit({ event: "server_started", port });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ event: "server_error", error: msg });
    }
  }

  function stopServer(): void {
    relayManager?.stopAll();
    if (rtmpServer?.isRunning()) {
      rtmpServer.stop();
      emit({ event: "server_stopped" });
    }
  }

  function emitStatus(): void {
    emit({
      event: "status",
      serverRunning: rtmpServer?.isRunning() ?? false,
      port: config.getPort(),
      streamActive: rtmpServer?.hasActiveStream() ?? false,
      relays: relayManager?.getStatuses() ?? [],
      destinations: config.getDestinations(),
      debugMode: config.getDebugMode(),
    });
  }

  function handleCommand(cmd: InboundCommand): void {
    switch (cmd.cmd) {
      case "start_server":
        startServer(cmd.port);
        break;

      case "stop_server":
        stopServer();
        break;

      case "add_destination":
        config.addDestination(cmd.destination);
        relayManager?.addDestination(cmd.destination);
        emit({
          event: "destinations_updated",
          destinations: config.getDestinations(),
        });
        break;

      case "remove_destination":
        config.removeDestination(cmd.id);
        relayManager?.removeDestination(cmd.id);
        emit({
          event: "destinations_updated",
          destinations: config.getDestinations(),
        });
        break;

      case "update_destination":
        config.updateDestination(cmd.destination);
        relayManager?.updateDestination(cmd.destination);
        emit({
          event: "destinations_updated",
          destinations: config.getDestinations(),
        });
        break;

      case "get_status":
        emitStatus();
        break;

      case "set_debug_mode":
        config.setDebugMode(cmd.enabled);
        emitDebugLog("sidecar", `Debug mode ${cmd.enabled ? "enabled" : "disabled"}`);
        emitStatus();
        break;

      case "shutdown":
        stopServer();
        process.exit(0);
    }
  }

  // Read commands from stdin
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
    stopServer();
    process.exit(0);
  });

  // Auto-start if configured
  if (config.getAutoStart()) {
    relayManager = initRelayManager();
    startServer(config.getPort());
  } else {
    relayManager = initRelayManager();
  }

  emit({ event: "ready" });
}

main();
