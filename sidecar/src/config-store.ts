import * as fs from "fs";
import * as path from "path";
import { AppConfig, Destination } from "./types";

const DEFAULT_CONFIG: AppConfig = {
  port: 1935,
  autoStart: true,
  debugMode: false,
  destinations: [],
};

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
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (err) {
      console.error("[config-store] Failed to load config:", err);
    }
    return { ...DEFAULT_CONFIG };
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
    return { ...this.config };
  }

  getDestinations(): Destination[] {
    return [...this.config.destinations];
  }

  getPort(): number {
    return this.config.port;
  }

  setPort(port: number): void {
    this.config.port = port;
    this.save();
  }

  getAutoStart(): boolean {
    return this.config.autoStart;
  }

  setAutoStart(autoStart: boolean): void {
    this.config.autoStart = autoStart;
    this.save();
  }

  getDebugMode(): boolean {
    return this.config.debugMode;
  }

  setDebugMode(enabled: boolean): void {
    this.config.debugMode = enabled;
    this.save();
  }

  addDestination(dest: Destination): void {
    this.config.destinations.push(dest);
    this.save();
  }

  updateDestination(dest: Destination): void {
    const idx = this.config.destinations.findIndex((d) => d.id === dest.id);
    if (idx !== -1) {
      this.config.destinations[idx] = dest;
      this.save();
    }
  }

  removeDestination(id: string): void {
    this.config.destinations = this.config.destinations.filter(
      (d) => d.id !== id
    );
    this.save();
  }

  getDestination(id: string): Destination | undefined {
    return this.config.destinations.find((d) => d.id === id);
  }
}
