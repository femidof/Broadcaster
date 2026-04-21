import { useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ProfileStatus } from "@/lib/types";
import { getVersion } from "@tauri-apps/api/app";

interface SettingsPanelProps {
  selectedProfile: ProfileStatus | null;
  canDeleteProfile: boolean;
  onProfileNameChange: (name: string) => void;
  onPortChange: (port: number) => void;
  onAutoStartChange: (autoStart: boolean) => void;
  onDeleteProfile: () => void;
  debugMode: boolean;
  onDebugModeChange: (enabled: boolean) => void;
  onCheckUpdates: () => void;
}

function ProfileSettingsFields({
  profile,
  canDeleteProfile,
  onProfileNameChange,
  onPortChange,
  onAutoStartChange,
  onDeleteProfile,
}: {
  profile: ProfileStatus;
  canDeleteProfile: boolean;
  onProfileNameChange: (name: string) => void;
  onPortChange: (port: number) => void;
  onAutoStartChange: (autoStart: boolean) => void;
  onDeleteProfile: () => void;
}) {
  const [portInput, setPortInput] = useState(String(profile.port));
  const [nameInput, setNameInput] = useState(profile.profileName);

  function handlePortBlur() {
    const parsed = parseInt(portInput, 10);
    if (!isNaN(parsed) && parsed >= 1024 && parsed <= 65535) {
      onPortChange(parsed);
    } else {
      setPortInput(String(profile.port));
    }
  }

  function handleNameBlur() {
    const next = nameInput.trim();
    if (next.length > 0 && next !== profile.profileName) {
      onProfileNameChange(next);
    } else {
      setNameInput(profile.profileName);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 flex-1 min-w-0">
            <Label>Profile name</Label>
            <p className="text-xs text-muted-foreground">
              Shown in the profile bar
            </p>
          </div>
          <Input
            className="max-w-[200px]"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNameBlur();
            }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>RTMP Ingest Port</Label>
            <p className="text-xs text-muted-foreground">
              Port for OBS on this profile (1024-65535)
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
            <Label>Auto-start server</Label>
            <p className="text-xs text-muted-foreground">
              Start this profile&apos;s RTMP server when the app launches
            </p>
          </div>
          <Switch
            checked={profile.autoStart}
            onCheckedChange={onAutoStartChange}
          />
        </div>

        {canDeleteProfile ? (
          <div className="pt-2 border-t">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="gap-2"
              onClick={onDeleteProfile}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete this profile
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SettingsPanel({
  selectedProfile,
  canDeleteProfile,
  onProfileNameChange,
  onPortChange,
  onAutoStartChange,
  onDeleteProfile,
  debugMode,
  onDebugModeChange,
  onCheckUpdates,
}: SettingsPanelProps) {
  const [appVersion, setAppVersion] = useState<string>("2.1.0");

  useEffect(() => {
    getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {
        // ignore (e.g. running outside tauri)
      });
  }, []);

  if (!selectedProfile) {
    return (
      <p className="text-sm text-muted-foreground">
        No profile selected. Create a profile from the bar above.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <ProfileSettingsFields
        key={`${selectedProfile.profileId}-${selectedProfile.port}-${selectedProfile.profileName}-${selectedProfile.autoStart}`}
        profile={selectedProfile}
        canDeleteProfile={canDeleteProfile}
        onProfileNameChange={onProfileNameChange}
        onPortChange={onPortChange}
        onAutoStartChange={onAutoStartChange}
        onDeleteProfile={onDeleteProfile}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Debug</CardTitle>
        </CardHeader>
        <CardContent>
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
              <p className="text-xs text-muted-foreground">Version {appVersion}</p>
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
              to Settings &gt; Stream. Set Service to &quot;Custom&quot;, Server to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                rtmp://localhost:{selectedProfile.port}/live
              </code>
              , and Stream Key to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                stream
              </code>
              .
            </p>
            <p>
              <strong className="text-foreground">Profiles:</strong> Each profile
              uses its own port so you can run multiple ingest servers at once (for
              example backup or split distribution). Switch profiles with the bar
              under the title bar.
            </p>
            <p>
              <strong className="text-foreground">How it works:</strong>{" "}
              Broadcaster receives your stream locally and re-broadcasts it to all
              enabled destinations for that profile using a built-in RTMP relay
              client.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
