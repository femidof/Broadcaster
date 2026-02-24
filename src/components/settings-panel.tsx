import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface SettingsPanelProps {
  port: number;
  autoStart: boolean;
  debugMode: boolean;
  onPortChange: (port: number) => void;
  onAutoStartChange: (autoStart: boolean) => void;
  onDebugModeChange: (enabled: boolean) => void;
  onCheckUpdates: () => void;
}

export function SettingsPanel({
  port,
  autoStart,
  debugMode,
  onPortChange,
  onAutoStartChange,
  onDebugModeChange,
  onCheckUpdates,
}: SettingsPanelProps) {
  const [portInput, setPortInput] = useState(String(port));

  function handlePortBlur() {
    const parsed = parseInt(portInput, 10);
    if (!isNaN(parsed) && parsed >= 1024 && parsed <= 65535) {
      onPortChange(parsed);
    } else {
      setPortInput(String(port));
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Server Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>RTMP Ingest Port</Label>
              <p className="text-xs text-muted-foreground">
                Port for OBS to connect to (1024-65535)
              </p>
            </div>
            <Input
              className="w-24 text-right"
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onBlur={handlePortBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePortBlur();
              }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-start Server</Label>
              <p className="text-xs text-muted-foreground">
                Start the RTMP server when the app launches
              </p>
            </div>
            <Switch checked={autoStart} onCheckedChange={onAutoStartChange} />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Debug Mode</Label>
              <p className="text-xs text-muted-foreground">
                Show diagnostic output for troubleshooting
              </p>
            </div>
            <Switch checked={debugMode} onCheckedChange={onDebugModeChange} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Broadcaster</p>
              <p className="text-xs text-muted-foreground">Version 0.1.0</p>
            </div>
            <Button variant="outline" size="sm" onClick={onCheckUpdates}>
              <RefreshCw className="h-3.5 w-3.5" />
              Check for Updates
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">OBS Setup:</strong> In OBS, go
              to Settings &gt; Stream. Set Service to "Custom", Server to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                rtmp://localhost:{port}/live
              </code>
              , and Stream Key to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                stream
              </code>
              .
            </p>
            <p>
              <strong className="text-foreground">How it works:</strong>{" "}
              Broadcaster receives your stream locally and re-broadcasts it to
              all enabled destinations simultaneously using FFmpeg.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
