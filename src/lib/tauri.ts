import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import type { Destination, SidecarEvent } from "./types";

export async function startSidecar(): Promise<void> {
  return invoke("start_sidecar");
}

export async function stopSidecar(): Promise<void> {
  return invoke("stop_sidecar");
}

export async function sendCommand(command: string): Promise<void> {
  return invoke("send_command", { command });
}

export async function addDestination(destination: Destination): Promise<void> {
  return invoke("add_destination", { destination });
}

export async function updateDestination(
  destination: Destination
): Promise<void> {
  return invoke("update_destination", { destination });
}

export async function removeDestination(id: string): Promise<void> {
  return invoke("remove_destination", { id });
}

export async function startServer(port: number): Promise<void> {
  return invoke("start_server", { port });
}

export async function stopServer(): Promise<void> {
  return invoke("stop_server");
}

export async function getStatus(): Promise<void> {
  return invoke("get_status");
}

export function onSidecarEvent(
  callback: (event: SidecarEvent) => void
): Promise<UnlistenFn> {
  return listen<SidecarEvent>("sidecar-event", (event) => {
    callback(event.payload);
  });
}

export async function setDebugMode(enabled: boolean): Promise<void> {
  return invoke("send_command", {
    command: JSON.stringify({ cmd: "set_debug_mode", enabled }),
  });
}

export async function checkForUpdates(): Promise<string> {
  try {
    const update = await check();
    if (update) {
      return `Update available: v${update.version}`;
    }
    return "You're on the latest version.";
  } catch {
    return "Could not check for updates.";
  }
}
