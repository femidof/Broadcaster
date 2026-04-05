import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AppConfig, Destination, Profile } from "./types";

export const DEFAULT_PROFILE_ID = "default";

function defaultProfile(): Profile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    port: 1935,
    autoStart: false,
    destinations: [],
  };
}

function defaultConfig(): AppConfig {
  return {
    debugMode: false,
    profiles: [defaultProfile()],
  };
}

function isDestination(value: unknown): value is Destination {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.platform === "string" &&
    typeof d.url === "string" &&
    typeof d.streamKey === "string" &&
    typeof d.enabled === "boolean"
  );
}

function parseProfile(value: unknown): Profile | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : randomUUID();
  const name = typeof o.name === "string" && o.name.length > 0 ? o.name : "Profile";
  const port =
    typeof o.port === "number" && o.port >= 1024 && o.port <= 65535 ? o.port : 1935;
  const autoStart = typeof o.autoStart === "boolean" ? o.autoStart : false;
  const destinations: Destination[] = Array.isArray(o.destinations)
    ? o.destinations.filter(isDestination)
    : [];
  return { id, name, port, autoStart, destinations };
}

function migrateFromV1Flat(o: Record<string, unknown>): AppConfig {
  const debugMode = typeof o.debugMode === "boolean" ? o.debugMode : false;
  const port =
    typeof o.port === "number" && o.port >= 1024 && o.port <= 65535 ? o.port : 1935;
  const autoStart = typeof o.autoStart === "boolean" ? o.autoStart : true;
  const destinations: Destination[] = Array.isArray(o.destinations)
    ? o.destinations.filter(isDestination)
    : [];
  return {
    debugMode,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: "Default",
        port,
        autoStart,
        destinations,
      },
    ],
  };
}

function parseConfig(raw: unknown): AppConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;

  if (Array.isArray(o.profiles)) {
    const profiles = o.profiles.map(parseProfile).filter((p): p is Profile => p !== null);
    const debugMode = typeof o.debugMode === "boolean" ? o.debugMode : base.debugMode;
    if (profiles.length === 0) return { debugMode, profiles: base.profiles };
    return { debugMode, profiles };
  }

  if ("port" in o || "destinations" in o || "autoStart" in o) {
    return migrateFromV1Flat(o);
  }

  const debugMode = typeof o.debugMode === "boolean" ? o.debugMode : base.debugMode;
  return { debugMode, profiles: base.profiles };
}

export class ConfigStore {
  private configPath: string;
  private config: AppConfig;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.configPath = path.join(dataDir, "config.json");
    this.config = this.load();
  }

  private load(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        return this.ensureAtLeastOneProfile(parseConfig(parsed));
      }
    } catch (err) {
      console.error("[config-store] Failed to load config:", err);
    }
    return defaultConfig();
  }

  private ensureAtLeastOneProfile(config: AppConfig): AppConfig {
    if (config.profiles.length > 0) return config;
    return { ...config, profiles: [defaultProfile()] };
  }

  private save(): void {
    try {
      const tmpPath = this.configPath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.configPath);
    } catch (err) {
      console.error("[config-store] Failed to save config:", err);
    }
  }

  getConfig(): AppConfig {
    return {
      debugMode: this.config.debugMode,
      profiles: this.config.profiles.map((p) => ({
        ...p,
        destinations: [...p.destinations],
      })),
    };
  }

  getProfiles(): Profile[] {
    return this.getConfig().profiles;
  }

  getProfile(id: string): Profile | undefined {
    return this.config.profiles.find((p) => p.id === id);
  }

  getDebugMode(): boolean {
    return this.config.debugMode;
  }

  setDebugMode(enabled: boolean): void {
    this.config.debugMode = enabled;
    this.save();
  }

  addProfile(profile: Profile): void {
    if (this.config.profiles.some((p) => p.id === profile.id)) {
      return;
    }
    this.config.profiles.push({
      ...profile,
      destinations: [...profile.destinations],
    });
    this.save();
  }

  updateProfile(profile: Profile): void {
    const idx = this.config.profiles.findIndex((p) => p.id === profile.id);
    if (idx === -1) return;
    this.config.profiles[idx] = {
      ...profile,
      destinations: [...profile.destinations],
    };
    this.save();
  }

  removeProfile(id: string): boolean {
    if (this.config.profiles.length <= 1) {
      return false;
    }
    const next = this.config.profiles.filter((p) => p.id !== id);
    if (next.length === this.config.profiles.length) {
      return false;
    }
    this.config.profiles = next;
    this.save();
    return true;
  }

  addDestination(profileId: string, dest: Destination): void {
    const p = this.getProfile(profileId);
    if (!p) return;
    p.destinations.push(dest);
    this.save();
  }

  updateDestination(profileId: string, dest: Destination): void {
    const p = this.getProfile(profileId);
    if (!p) return;
    const idx = p.destinations.findIndex((d) => d.id === dest.id);
    if (idx !== -1) {
      p.destinations[idx] = dest;
      this.save();
    }
  }

  removeDestination(profileId: string, id: string): void {
    const p = this.getProfile(profileId);
    if (!p) return;
    p.destinations = p.destinations.filter((d) => d.id !== id);
    this.save();
  }
}
