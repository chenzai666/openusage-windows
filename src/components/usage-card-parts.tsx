import { cn } from "@/lib/utils"

export function HealthDots({ percent }: { percent: number | null }) {
  const pct =
    percent == null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent))
  const total = 18
  // Dots show remaining quota; progress bars show consumed quota.
  const filled =
    pct == null || pct >= 100 ? 0 : Math.max(1, Math.round(((100 - pct) / 100) * total))
  return (
    <div className="flex items-center gap-[3px] flex-1 min-w-0 h-3" aria-hidden>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-[7px] max-w-[7px] min-w-0 flex-1 rounded-full",
            i < filled ? "bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.55)]" : "bg-white/12"
          )}
        />
      ))}
    </div>
  )
}

export function ThinBar({ percent, color }: { percent: number | null; color?: string }) {
  if (percent == null || !Number.isFinite(percent)) return null
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div className="mt-1 h-[3px] w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className="h-full rounded-full transition-all motion-reduce:transition-none"
        style={{ width: `${p}%`, backgroundColor: color || "#34d399" }}
      />
    </div>
  )
}

export function MetricBlock({
  label,
  value,
  barPercent,
  muted
}: {
  label: string
  value: string
  barPercent?: number | null
  muted?: boolean
}) {
  return (
    <div className="py-0.5">
      <div className="flex justify-between items-baseline gap-2 text-[12px] leading-5">
        <span className="text-white/45 shrink-0">{label}</span>
        <span
          className={cn(
            "text-right tabular-nums min-w-0 truncate text-[12px]",
            muted ? "text-white/35" : "text-white/85"
          )}
          title={value}
        >
          {value}
        </span>
      </div>
      {barPercent != null && <ThinBar percent={barPercent} />}
    </div>
  )
}

export function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
