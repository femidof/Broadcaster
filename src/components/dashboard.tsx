import {
  Radio,
  Wifi,
  WifiOff,
  Circle,
  AlertCircle,
  RefreshCw,
  Play,
  Square,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SignalStrength } from "@/components/signal-strength";
import { BitrateSparkline } from "@/components/analytics/bitrate-sparkline";
import type { DashboardStatus, RelayStatus } from "@/lib/types";
import type { featureFlags } from "@/lib/feature-flags";
import { getReliabilityFix } from "@/lib/reliability/error-map";

interface DashboardProps {
  status: DashboardStatus;
  onStartServer: () => void;
  onStopServer: () => void;
  onPushDestinations: () => void;
  onStopPushing: () => void;
  onRefresh: () => void;
  featureFlags: typeof featureFlags;
  onOpenConnectionDoctor?: (destinationId: string) => void;
  bitrateSeries?: Record<string, { t: number; kbps: number }[]>;
  lastSession?: {
    startTs: number;
    endTs: number;
    durationMs: number;
    perDest: Record<string, { avgKbps: number; maxKbps: number; samples: number }>;
    restarts: Record<string, number>;
    errors: Record<string, string | undefined>;
  } | null;
}

function RelayStatusBadge({ status }: { status: RelayStatus["status"] }) {
  switch (status) {
    case "live":
      return <Badge variant="success">Live</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">Idle</Badge>;
  }
}

export function Dashboard({
  status,
  onStartServer,
  onStopServer,
  onPushDestinations,
  onStopPushing,
  onRefresh,
  featureFlags,
  onOpenConnectionDoctor,
  bitrateSeries,
  lastSession,
}: DashboardProps) {
  const enabledDestinations = status.destinations.filter((d) => d.enabled);
  const canGoLive =
    status.streamActive && enabledDestinations.length > 0 && !status.pushing;

  return (
    <div className="space-y-6">
      {/* Server Status */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Radio className="h-4 w-4" />
              RTMP Server
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" onClick={onRefresh}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              {status.serverRunning ? (
                <Button variant="destructive" size="sm" onClick={onStopServer}>
                  Stop Server
                </Button>
              ) : (
                <Button size="sm" onClick={onStartServer}>
                  Start Server
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Status</p>
              <div className="flex items-center gap-2">
                {status.serverRunning ? (
                  <>
                    <Circle className="h-2.5 w-2.5 fill-success text-success" />
                    <span className="text-sm font-medium">Running</span>
                  </>
                ) : (
                  <>
                    <Circle className="h-2.5 w-2.5 fill-muted-foreground text-muted-foreground" />
                    <span className="text-sm font-medium text-muted-foreground">
                      Stopped
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Ingest URL</p>
              <p className="text-sm font-mono">
                rtmp://localhost:{status.port}/live
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Stream</p>
              <div className="flex items-center gap-2">
                {status.streamActive ? (
                  <>
                    <Wifi className="h-4 w-4 text-success" />
                    <span className="text-sm font-medium text-success">
                      Connected
                    </span>
                  </>
                ) : (
                  <>
                    <WifiOff className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      No stream
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Go Live Control */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">
                {status.pushing
                  ? "Streaming to destinations"
                  : status.streamActive
                    ? "Source connected — ready to go live"
                    : "Waiting for source stream"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {status.pushing
                  ? `Pushing to ${enabledDestinations.length} destination${enabledDestinations.length !== 1 ? "s" : ""}`
                  : !status.streamActive
                    ? "Connect OBS or your encoder first"
                    : enabledDestinations.length === 0
                      ? "Enable at least one destination"
                      : `${enabledDestinations.length} destination${enabledDestinations.length !== 1 ? "s" : ""} ready`}
              </p>
            </div>
            {status.pushing ? (
              <Button
                variant="destructive"
                onClick={onStopPushing}
                className="gap-2"
              >
                <Square className="h-4 w-4" />
                Stop Pushing
              </Button>
            ) : (
              <Button
                onClick={onPushDestinations}
                disabled={!canGoLive}
                className="gap-2"
              >
                <Play className="h-4 w-4" />
                Go Live
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Relay Status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Relay Status</CardTitle>
        </CardHeader>
        <CardContent>
          {status.relays.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No destinations configured. Add destinations to start relaying.
            </p>
          ) : (
            <div className="space-y-3">
              {status.relays.map((relay) => (
                <div
                  key={relay.destinationId}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <RelayStatusBadge status={relay.status} />
                    <span className="text-sm font-medium">{relay.name}</span>
                    <SignalStrength
                      bitrateKbps={relay.bitrateKbps}
                      status={relay.status}
                    />
                    {featureFlags.analytics && bitrateSeries?.[relay.destinationId] ? (
                      <div className="text-muted-foreground">
                        <BitrateSparkline points={bitrateSeries[relay.destinationId]} />
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {relay.error && (
                      <div className="flex items-start gap-2">
                        <span className="flex items-center gap-1 text-destructive">
                          <AlertCircle className="h-3 w-3" />
                        </span>
                        <div className="min-w-0">
                          <div className="text-destructive wrap-break-word">
                            {relay.error}
                          </div>
                          {featureFlags.reliabilitySuite ? (
                            (() => {
                              const dest = status.destinations.find(
                                (d) => d.id === relay.destinationId
                              );
                              if (!dest) return null;
                              const fix = getReliabilityFix(dest.platform, relay.error);
                              return (
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <span className="text-muted-foreground">
                                    {fix.title}
                                  </span>
                                  {onOpenConnectionDoctor ? (
                                    <Button
                                      type="button"
                                      variant="link"
                                      size="sm"
                                      className="h-auto p-0 text-xs"
                                      onClick={() => onOpenConnectionDoctor(relay.destinationId)}
                                    >
                                      Fix it
                                    </Button>
                                  ) : null}
                                </div>
                              );
                            })()
                          ) : null}
                        </div>
                      </div>
                    )}
                    {relay.restartCount > 0 && (
                      <span>Restarts: {relay.restartCount}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Analytics: last session */}
      {featureFlags.analytics && lastSession ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Session Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-muted-foreground">
              Duration:{" "}
              <span className="text-foreground font-medium">
                {Math.round(lastSession.durationMs / 1000)}s
              </span>
            </div>
            <div className="space-y-2">
              {Object.entries(lastSession.perDest).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No samples captured for this session.
                </p>
              ) : (
                Object.entries(lastSession.perDest).map(([destId, s]) => {
                  const name =
                    status.destinations.find((d) => d.id === destId)?.name ??
                    destId;
                  const restarts = lastSession.restarts[destId] ?? 0;
                  const err = lastSession.errors[destId];
                  return (
                    <div
                      key={destId}
                      className="flex items-center justify-between rounded-md border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{name}</div>
                        <div className="text-xs text-muted-foreground">
                          Avg {s.avgKbps} kbps · Max {s.maxKbps} kbps · Samples {s.samples}
                        </div>
                        {err ? (
                          <div className="text-xs text-destructive truncate">
                            {err}
                          </div>
                        ) : null}
                      </div>
                      {restarts > 0 ? (
                        <Badge variant="warning">Restarts: {restarts}</Badge>
                      ) : (
                        <Badge variant="secondary">OK</Badge>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Quick Instructions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quick Start</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-muted-foreground">
            <li>Add your streaming destinations in the Destinations tab</li>
            <li>
              Open OBS and set the stream URL to{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                rtmp://localhost:{status.port}/live
              </code>
            </li>
            <li>
              Use any stream key (e.g.{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                stream
              </code>
              )
            </li>
            <li>Start streaming in OBS</li>
            <li>Click "Go Live" to push to your destinations</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
