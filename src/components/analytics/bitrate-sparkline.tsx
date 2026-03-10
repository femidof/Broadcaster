import { useMemo } from "react";
import { cn } from "@/lib/utils";

type Point = { t: number; kbps: number };

export function BitrateSparkline({
  points,
  className,
}: {
  points: Point[];
  className?: string;
}) {
  const { d, max } = useMemo(() => {
    if (!points || points.length < 2) return { d: "", max: 0 };

    const values = points.map((p) => p.kbps);
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const span = Math.max(max - min, 1);

    const w = 120;
    const h = 22;

    const toX = (i: number) => (i / (points.length - 1)) * w;
    const toY = (kbps: number) => {
      const norm = (kbps - min) / span;
      return h - norm * h;
    };

    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(2)} ${toY(p.kbps).toFixed(2)}`)
      .join(" ");

    return { d, max };
  }, [points]);

  if (!d) return null;

  return (
    <svg
      viewBox="0 0 120 22"
      className={cn("h-[22px] w-[120px] opacity-90", className)}
      aria-label={`Bitrate sparkline (max ${max} kbps)`}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

