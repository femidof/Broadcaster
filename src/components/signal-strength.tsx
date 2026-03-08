import { cn } from "@/lib/utils";

interface SignalStrengthProps {
  bitrateKbps: number;
  status: "idle" | "live" | "error";
  className?: string;
}

/**
 * Determines signal level (0-4) from outbound bitrate.
 *
 * Typical live-stream bitrates:
 *   - Audio-only ~128 kbps
 *   - 720p      ~2 500–4 000 kbps
 *   - 1080p     ~4 500–6 000+ kbps
 *
 * Thresholds are set so that any meaningful data flow
 * lights at least one bar, and a healthy relay lights all four.
 */
function getLevel(bitrateKbps: number): number {
  if (bitrateKbps <= 0) return 0;
  if (bitrateKbps < 200) return 1;
  if (bitrateKbps < 1000) return 2;
  if (bitrateKbps < 3000) return 3;
  return 4;
}

function getLevelColor(level: number, status: string): string {
  if (status === "error") return "bg-destructive";
  if (level === 0) return "bg-muted-foreground/30";
  if (level === 1) return "bg-destructive";
  if (level === 2) return "bg-warning";
  return "bg-success";
}

function formatBitrate(kbps: number): string {
  if (kbps <= 0) return "";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

const BAR_HEIGHTS = ["h-1.5", "h-2.5", "h-3.5", "h-[18px]"];

export function SignalStrength({
  bitrateKbps,
  status,
  className,
}: SignalStrengthProps) {
  if (status === "idle") return null;

  const level = status === "error" ? 0 : getLevel(bitrateKbps);
  const activeColor = getLevelColor(level, status);
  const label = formatBitrate(bitrateKbps);

  return (
    <div className={cn("flex items-end gap-0.5", className)} title={label || undefined}>
      {BAR_HEIGHTS.map((h, i) => (
        <div
          key={i}
          className={cn(
            "w-[3px] rounded-sm transition-colors duration-300",
            h,
            i < level ? activeColor : "bg-muted-foreground/20"
          )}
        />
      ))}
      {label && (
        <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground">
          {label}
        </span>
      )}
    </div>
  );
}
