import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import type { Destination, Profile, SidecarEvent } from "./types";

export async function startSidecar(): Promise<void> {
  return invoke("start_sidecar");
}

export async function stopSidecar(): Promise<void> {
  return invoke("stop_sidecar");
}

export async function sendCommand(command: string): Promise<void> {
  return invoke("send_command", { command });
}

export async function createProfile(profile: Profile): Promise<void> {
  return invoke("create_profile", { profile });
}

export async function updateProfile(profile: Profile): Promise<void> {
  return invoke("update_profile", { profile });
}

export async function deleteProfile(profileId: string): Promise<void> {
  return invoke("delete_profile", { profileId });
}

export async function addDestination(
  profileId: string,
  destination: Destination
): Promise<void> {
  return invoke("add_destination", { profileId, destination });
}

export async function updateDestination(
  profileId: string,
  destination: Destination
): Promise<void> {
  return invoke("update_destination", { profileId, destination });
}

export async function removeDestination(
  profileId: string,
  id: string
): Promise<void> {
  return invoke("remove_destination", { profileId, id });
}

export async function pushDestinations(profileId: string): Promise<void> {
  return invoke("push_destinations", { profileId });
}

export async function stopPushing(profileId: string): Promise<void> {
  return invoke("stop_pushing", { profileId });
}

export async function startServer(profileId: string): Promise<void> {
  return invoke("start_server", { profileId });
}

export async function stopServer(profileId: string): Promise<void> {
  return invoke("stop_server", { profileId });
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
