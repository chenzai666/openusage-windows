import { useMemo, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import {
  FlaskConical,
  Maximize2,
  Minimize2,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { MetricLine } from "@/lib/plugin-types"

/** Structured payload from plugins/grok `label: "__grok_v1"`. */
export type GrokAccountCard = {
  entryKey: string
  title: string
  emailMasked: string
  labels: string[]
  status: string
  statusColor: string
  tier: number | string | null
  planName: string | null
  planLine: string
  refreshedAt: string | null
  unifiedNote: string | null
  probe: {
    ok: number
    fail: number
    billing: { ok: boolean; code: number } | null
    settings: { ok: boolean; code: number } | null
    chat: { ok: boolean; code: number } | null
    note: string | null
    testedAt: string | null
  }
  weeklyPercent: number | null
  weeklyReset: string | null
  buildText: string | null
  buildPercent: number | null
  apiUsed: number | null
  apiLimit: number | null
  apiPercent: number | null
  apiReset: string | null
  onDemandText: string
  payAsYouGo: string
  parseSummary: string | null
  subscription: string | null
  enabled: boolean
}

export type GrokPayloadV1 = {
  v: 1
  accounts: GrokAccountCard[]
  trayEntryKey?: string | null
}

export function extractGrokPayload(lines: MetricLine[]): GrokPayloadV1 | null {
  const hit = lines.find((l) => l.type === "text" && l.label === "__grok_v1")
  if (!hit || hit.type !== "text") return null
  try {
    const data = JSON.parse(hit.value) as GrokPayloadV1
    if (!data || data.v !== 1 || !Array.isArray(data.accounts)) return null
    return data
  } catch {
    return null
  }
}

function HealthDots({ percent }: { percent: number | null }) {
  const pct = percent == null ? 0 : Math.max(0, Math.min(100, percent))
  // Screenshot: ~16 dots, filled left→right by remaining? Design shows green first then gray
  // "健康" uses remaining: 0% used → all green-ish first dots. Screenshot 0% used → first dot green.
  // Treat as: first dots = healthy/remaining presence. At 0% used, one green + rest gray dim.
  const total = 16
  // Fill count = remaining health: (100 - used) / 100 * total, min 1 if 0% used
  const remaining = 100 - pct
  const filled = pct >= 100 ? 0 : Math.max(1, Math.round((remaining / 100) * total))
  return (
    <div className="flex items-center gap-0.5 flex-1 min-w-0" aria-hidden>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            i < filled ? "bg-emerald-500" : "bg-muted-foreground/25"
          )}
        />
      ))}
    </div>
  )
}

function MetricRow({
  label,
  value,
  muted,
}: {
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className="flex justify-between items-baseline gap-2 text-[12px] leading-5">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        className={cn(
          "text-right tabular-nums min-w-0 truncate",
          muted ? "text-muted-foreground" : "text-foreground/90"
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function ProbeTag({
  name,
  ok,
  code,
}: {
  name: string
  ok: boolean
  code: number
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border",
        ok
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-red-500/40 text-red-600 dark:text-red-400"
      )}
    >
      {name} {ok ? "✓" : "✗"} {code || "—"}
    </span>
  )
}

type GrokCardsViewProps = {
  payload: GrokPayloadV1
  onRetry?: () => void
  onOpenSettings?: () => void
  compact?: boolean
  /** Last successful probe time (ms). */
  lastUpdatedAt?: number | null
  /** Next auto-refresh time (ms). */
  autoUpdateNextAt?: number | null
  workbench?: boolean
  onToggleWorkbench?: () => void
}

function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function GrokCardsView({
  payload,
  onRetry,
  onOpenSettings,
  compact = false,
  lastUpdatedAt = null,
  autoUpdateNextAt = null,
  workbench = false,
  onToggleWorkbench,
}: GrokCardsViewProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const accounts = payload.accounts

  const trayKey = useMemo(() => {
    if (payload.trayEntryKey) return payload.trayEntryKey
    const enabled = accounts.find((a) => a.enabled)
    return enabled?.entryKey ?? accounts[0]?.entryKey ?? null
  }, [payload.trayEntryKey, accounts])

  const setEnabled = async (entryKey: string, enabled: boolean) => {
    if (!isTauri()) return
    setBusyKey(entryKey)
    setError(null)
    try {
      await invoke("grok_set_tray_account", {
        entryKey: enabled ? entryKey : null,
      })
      onRetry?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyKey(null)
    }
  }

  const removeAccount = async (entryKey: string) => {
    if (!isTauri()) return
    if (!window.confirm("确定从本机 auth.json 移除此 Grok 账号？")) return
    setBusyKey(entryKey)
    setError(null)
    try {
      await invoke("grok_remove_account", { entryKey })
      onRetry?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusyKey(null)
    }
  }

  const testAll = async () => {
    setTestingAll(true)
    setError(null)
    try {
      // Full probe re-runs billing/settings/chat for every account.
      onRetry?.()
    } finally {
      window.setTimeout(() => setTestingAll(false), 800)
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center">
        暂无 Grok 账号。请到设置中添加登录。
      </div>
    )
  }

  const okCount = accounts.filter((a) => a.status === "正常").length
  const warnCount = accounts.length - okCount

  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      {/* Workbench toolbar — design doc 7.4 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1.5">
        <div className="min-w-0 flex-1 text-[11px] text-muted-foreground leading-snug">
          <span className="font-medium text-foreground">
            {accounts.length} 账号
          </span>
          <span className="mx-1.5 opacity-40">·</span>
          正常 {okCount} / 异常 {warnCount}
          <span className="mx-1.5 opacity-40">·</span>
          上次 {formatClock(lastUpdatedAt)}
          <span className="mx-1.5 opacity-40">·</span>
          下次 {formatClock(autoUpdateNextAt)}
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-7 text-[11px] gap-1"
          disabled={testingAll}
          onClick={() => void testAll()}
          title="串行刷新全部账号（含 billing/settings/chat）"
        >
          <FlaskConical className="size-3.5" />
          {testingAll ? "测试中…" : "一键测试全部"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-7 text-[11px] gap-1"
          onClick={() => onRetry?.()}
        >
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-7 text-[11px] gap-1"
          onClick={() => onOpenSettings?.()}
        >
          <Settings className="size-3.5" />
          设置
        </Button>
        {onToggleWorkbench && (
          <Button
            type="button"
            size="xs"
            variant={workbench ? "default" : "outline"}
            className="h-7 text-[11px] gap-1"
            onClick={onToggleWorkbench}
            title={workbench ? "退出全屏工作台" : "全屏工作台"}
          >
            {workbench ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
            {workbench ? "退出全屏" : "全屏"}
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive break-words">{error}</p>
      )}
      <div
        className={cn(
          "grid gap-3",
          workbench
            ? "grid-cols-1 sm:grid-cols-2"
            : "grid-cols-1"
        )}
      >
        {accounts.map((acc) => {
          const isTray = trayKey === acc.entryKey
          const weeklyText =
            acc.weeklyPercent == null
              ? "—"
              : `已用 ${Math.round(acc.weeklyPercent)}%` +
                (acc.weeklyReset ? ` · 重置 ${acc.weeklyReset}` : "")
          const apiText =
            acc.apiUsed != null && acc.apiLimit != null
              ? `已用 ${Math.round(acc.apiPercent ?? 0)}% · ${acc.apiUsed} / ${acc.apiLimit}` +
                (acc.apiReset ? ` · 重置 ${acc.apiReset}` : "")
              : "—"
          const buildText =
            acc.buildPercent != null
              ? `已用 ${Math.round(acc.buildPercent)}%`
              : acc.buildText || "接口未返回 Build 字段"

          return (
            <div
              key={acc.entryKey}
              className="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden"
            >
              {/* Header */}
              <div className="px-3 pt-3 pb-2 space-y-1.5">
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 h-3.5 w-3.5 accent-foreground"
                    checked={isTray}
                    disabled={busyKey === acc.entryKey}
                    onChange={(e) => void setEnabled(acc.entryKey, e.target.checked)}
                    title="设为托盘账号"
                    aria-label="设为托盘账号"
                  />
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background text-[10px] font-bold">
                    xAI
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground">
                        xAI
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium border"
                        style={{
                          color: acc.statusColor,
                          borderColor: acc.statusColor,
                        }}
                      >
                        {acc.status}
                      </span>
                      {acc.labels.map((lb) => (
                        <span
                          key={lb}
                          className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {lb}
                        </span>
                      ))}
                    </div>
                    <div className="text-[15px] font-semibold leading-tight mt-0.5 truncate">
                      {acc.title}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {acc.emailMasked}
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-muted-foreground">
                  {acc.planLine ||
                    (acc.tier != null
                      ? `层级 ${acc.tier}${acc.planName ? " · " + acc.planName : ""}`
                      : acc.planName || "Grok")}
                  {acc.subscription ? ` · 续费 ${acc.subscription}` : ""}
                </div>

                {acc.unifiedNote && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200/90 flex gap-1.5">
                    <span className="shrink-0 opacity-80">ⓘ</span>
                    <span>{acc.unifiedNote}</span>
                  </div>
                )}

                {/* Probe results */}
                <div className="space-y-1.5 pt-0.5">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 text-[10px] font-medium">
                      成功 {acc.probe.ok}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium",
                        acc.probe.fail > 0
                          ? "bg-red-500/15 text-red-700 dark:text-red-400"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      失败 {acc.probe.fail}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {acc.probe.billing && (
                      <ProbeTag
                        name="billing"
                        ok={acc.probe.billing.ok}
                        code={acc.probe.billing.code}
                      />
                    )}
                    {acc.probe.settings && (
                      <ProbeTag
                        name="settings"
                        ok={acc.probe.settings.ok}
                        code={acc.probe.settings.code}
                      />
                    )}
                    {acc.probe.chat && (
                      <ProbeTag
                        name="chat"
                        ok={acc.probe.chat.ok}
                        code={acc.probe.chat.code}
                      />
                    )}
                  </div>
                  {acc.probe.note && (
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      {acc.probe.note}
                    </p>
                  )}
                  {acc.probe.testedAt && (
                    <p className="text-[10px] text-muted-foreground/80">
                      {acc.probe.testedAt}
                    </p>
                  )}
                </div>
              </div>

              {/* Metrics */}
              <div className="px-3 pb-2 space-y-1.5 border-t border-border/60 pt-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-muted-foreground shrink-0">健康状态（周限）</span>
                  <HealthDots percent={acc.weeklyPercent} />
                  <span className="text-muted-foreground tabular-nums shrink-0 w-8 text-right">
                    {acc.weeklyPercent == null ? "—" : `${Math.round(acc.weeklyPercent)}%`}
                  </span>
                </div>
                <MetricRow label="周限额" value={weeklyText} />
                <MetricRow label="Build 用量" value={buildText} muted={acc.buildPercent == null} />
                <MetricRow label="API 月额度" value={apiText} />
                <MetricRow label="按量已用" value={acc.onDemandText} muted />
                {acc.parseSummary && (
                  <p className="text-[10px] text-muted-foreground/70 leading-snug pt-0.5">
                    {acc.parseSummary}
                  </p>
                )}
                <MetricRow label="按量付费" value={acc.payAsYouGo} muted={acc.payAsYouGo === "未启用"} />
              </div>

              {/* Footer actions — design screenshot bottom bar */}
              <div className="flex items-center gap-1 px-2 py-2 border-t border-border/60 bg-muted/20">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-7 gap-1 text-[11px]"
                  onClick={() => onRetry?.()}
                  title="接口探测 + 刷新用量"
                >
                  <FlaskConical className="size-3.5" />
                  测试
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7 w-7"
                  onClick={() => onRetry?.()}
                  title="刷新"
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7 w-7"
                  onClick={() => onOpenSettings?.()}
                  title="账号设置"
                >
                  <Settings className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  disabled={busyKey === acc.entryKey}
                  onClick={() => void removeAccount(acc.entryKey)}
                  title="删除账号"
                >
                  <Trash2 className="size-3.5" />
                </Button>
                <div className="flex-1" />
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none pr-1">
                  启用
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isTray}
                    disabled={busyKey === acc.entryKey}
                    onClick={() => void setEnabled(acc.entryKey, !isTray)}
                    className={cn(
                      "relative h-5 w-9 rounded-full transition-colors",
                      isTray ? "bg-primary" : "bg-muted-foreground/30"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
                        isTray && "translate-x-4"
                      )}
                    />
                  </button>
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
