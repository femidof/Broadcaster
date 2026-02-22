import { Trash2, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { Destination, RelayStatus } from "@/lib/types";

interface DestinationCardProps {
  destination: Destination;
  relayStatus?: RelayStatus;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}

function PlatformIcon({ platform }: { platform: string }) {
  const labels: Record<string, string> = {
    twitch: "TW",
    youtube: "YT",
    custom: "RT",
  };
  const colors: Record<string, string> = {
    twitch: "bg-purple-600",
    youtube: "bg-red-600",
    custom: "bg-blue-600",
  };
  return (
    <div
      className={`flex h-8 w-8 items-center justify-center rounded-md text-xs font-bold text-white ${colors[platform] ?? "bg-gray-600"}`}
    >
      {labels[platform] ?? "?"}
    </div>
  );
}

function StatusBadge({ status }: { status?: RelayStatus }) {
  if (!status) return <Badge variant="secondary">Idle</Badge>;
  switch (status.status) {
    case "live":
      return <Badge variant="success">Live</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">Idle</Badge>;
  }
}

export function DestinationCard({
  destination,
  relayStatus,
  onToggle,
  onEdit,
  onRemove,
}: DestinationCardProps) {
  return (
    <Card className={!destination.enabled ? "opacity-60" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <PlatformIcon platform={destination.platform} />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                {destination.name}
              </span>
              <StatusBadge status={relayStatus} />
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {destination.url}
            </p>
          </div>

          <div className="flex items-center gap-1">
            <Switch
              checked={destination.enabled}
              onCheckedChange={onToggle}
            />
            <Button variant="ghost" size="icon" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onRemove}>
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
