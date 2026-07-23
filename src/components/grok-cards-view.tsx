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
  /** Prepaid / monthly API display line (design: API 预付余额) */
  apiPrepaidText?: string | null
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
  const pct = percent == null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent))
  const total = 18
  // Design: remaining health dots left→right. 0% used → almost all lit; 100% → none.
  const filled =
    pct == null ? 0 : pct >= 100 ? 0 : Math.max(1, Math.round(((100 - pct) / 100) * total))
  return (
    <div className="flex items-center gap-[3px] flex-1 min-w-0 h-3" aria-hidden>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-[7px] w-[7px] rounded-full shrink-0",
            i < filled ? "bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.55)]" : "bg-white/12"
          )}
        />
      ))}
    </div>
  )
}

function ThinBar({ percent, color }: { percent: number | null; color?: string }) {
  if (percent == null || !Number.isFinite(percent)) return null
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div className="mt-1 h-[3px] w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${p}%`,
          backgroundColor: color || "#34d399",
        }}
      />
    </div>
  )
}

function MetricBlock({
  label,
  value,
  barPercent,
  muted,
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
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium border",
        ok
          ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
          : "border-red-500/35 bg-red-500/10 text-red-400"
      )}
    >
      {name} {ok ? "✓" : "✗"} {code || "—"}
    </span>
  )
}

function StatusChip({ status, color }: { status: string; color: string }) {
  const isOk = status === "正常"
  const isWarn = status === "警告" || status === "限制" || status === "需重新登录"
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium border",
        isOk && "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
        isWarn && !isOk && "border-amber-500/40 text-amber-300 bg-amber-500/10"
      )}
      style={
        !isOk && !isWarn
          ? { color, borderColor: color, backgroundColor: `${color}18` }
          : undefined
      }
    >
      {status}
    </span>
  )
}

function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** tier line like reference: "tier 1 · SuperGrok · 刷新 07/16 15:32" */
function formatTierPlanLine(acc: GrokAccountCard): string {
  if (acc.planLine && acc.planLine.trim()) {
    // Prefer English "tier N" style from reference
    return acc.planLine
      .replace(/^层级\s*/i, "tier ")
      .replace(/层级\s*/g, "tier ")
  }
  const parts: string[] = []
  if (acc.tier != null && acc.tier !== "") parts.push(`tier ${acc.tier}`)
  if (acc.planName) parts.push(acc.planName)
  if (acc.refreshedAt) parts.push(`刷新 ${acc.refreshedAt}`)
  return parts.join(" · ") || "Grok"
}

type GrokCardsViewProps = {
  payload: GrokPayloadV1
  onRetry?: () => void
  onOpenSettings?: () => void
  compact?: boolean
  lastUpdatedAt?: number | null
  autoUpdateNextAt?: number | null
  workbench?: boolean
  onToggleWorkbench?: () => void
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
  // Reference: multi-column whenever 2+ accounts (or workbench forced)
  const multiCol = workbench || accounts.length > 1
  const colClass =
    accounts.length >= 3
      ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
      : accounts.length === 2 || workbench
        ? "grid-cols-1 sm:grid-cols-2"
        : "grid-cols-1"

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl",
        // Pure dark workbench canvas like reference
        "bg-[#0a0a0a] p-2 -mx-1",
        compact && "space-y-2 p-1.5"
      )}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5">
        <div className="min-w-0 flex-1 text-[11px] text-white/50 leading-snug">
          <span className="font-medium text-white/85">{accounts.length} 账号</span>
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
          className="h-7 text-[11px] gap-1 border-white/15 bg-white/5 text-white/80 hover:bg-white/10"
          disabled={testingAll}
          onClick={() => void testAll()}
        >
          <FlaskConical className="size-3.5" />
          {testingAll ? "测试中…" : "一键测试全部"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-7 text-[11px] gap-1 border-white/15 bg-white/5 text-white/80 hover:bg-white/10"
          onClick={() => onRetry?.()}
        >
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-7 text-[11px] gap-1 border-white/15 bg-white/5 text-white/80 hover:bg-white/10"
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
            className={cn(
              "h-7 text-[11px] gap-1",
              !workbench && "border-white/15 bg-white/5 text-white/80 hover:bg-white/10"
            )}
            onClick={onToggleWorkbench}
          >
            {workbench ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            {workbench ? "退出全屏" : "全屏"}
          </Button>
        )}
      </div>

      {error && <p className="text-xs text-red-400 break-words px-1">{error}</p>}

      <div className={cn("grid gap-3", multiCol ? colClass : "grid-cols-1")}>
        {accounts.map((acc) => {
          const isTray = trayKey === acc.entryKey
          const weeklyText =
            acc.weeklyPercent == null
              ? "无周额度数据"
              : `已用 ${Math.round(acc.weeklyPercent)}%` +
                (acc.weeklyReset ? ` · 重置 ${acc.weeklyReset}` : "")
          // Design labels: API 预付余额 when we have dollar-like monthly, else API 用量
          const apiLabel =
            acc.apiUsed != null && acc.apiLimit != null ? "API 预付余额" : "API 用量"
          const apiText =
            acc.apiPrepaidText ||
            (acc.apiUsed != null && acc.apiLimit != null
              ? `已用 -- · 余额 US$${(acc.apiLimit / 100).toFixed(2)}` +
                (acc.apiReset ? ` · 重置 ${acc.apiReset}` : "")
              : "接口未返回 API 字段")
          const buildText =
            acc.buildPercent != null
              ? `已用 ${Math.round(acc.buildPercent)}%`
              : acc.buildText || "接口未返回 Build 字段"

          const dateChip = acc.subscription
            ? acc.subscription.split("·")[0]?.trim()
            : null

          return (
            <div
              key={acc.entryKey}
              className="rounded-2xl border border-white/10 bg-[#121212] text-white shadow-[0_8px_30px_rgba(0,0,0,0.45)] overflow-hidden flex flex-col min-w-0"
            >
              {/* Header */}
              <div className="px-3 pt-3 pb-2 space-y-2">
                <div className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-2 h-3.5 w-3.5 accent-white/80 shrink-0"
                    checked={isTray}
                    disabled={busyKey === acc.entryKey}
                    onChange={(e) => void setEnabled(acc.entryKey, e.target.checked)}
                    title="设为托盘账号"
                    aria-label="设为托盘账号"
                  />
                  {/* Circular monochrome xAI mark */}
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black text-[10px] font-bold tracking-tight">
                    xAI
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold border border-white/15 text-white/70">
                        xAI
                      </span>
                      <StatusChip status={acc.status} color={acc.statusColor} />
                      {acc.labels.map((lb) => (
                        <span
                          key={lb}
                          className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/55"
                        >
                          {lb}
                        </span>
                      ))}
                      {dateChip && (
                        <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-white/45">
                          {dateChip}
                        </span>
                      )}
                    </div>
                    <div className="text-[15px] font-semibold leading-tight mt-1 truncate text-white">
                      {acc.title}
                    </div>
                    <div className="text-[11px] text-white/30 truncate blur-[2px] select-none">
                      {acc.emailMasked}
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-white/45">
                  {formatTierPlanLine(acc)}
                </div>

                {acc.unifiedNote && (
                  <div className="rounded-lg border border-red-900/50 bg-[#2a1214] px-2.5 py-2 text-[11px] text-red-200/90 flex gap-1.5 leading-snug">
                    <span className="shrink-0 opacity-80">ⓘ</span>
                    <span>{acc.unifiedNote}</span>
                  </div>
                )}

                {/* Probe panel */}
                <div className="rounded-xl border border-white/8 bg-black/40 px-2.5 py-2 space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-md bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 text-[10px] font-medium">
                      成功 {acc.probe.ok}
                    </span>
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                        acc.probe.fail > 0
                          ? "bg-red-500/15 text-red-400"
                          : "bg-white/5 text-white/40"
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
                    <p className="text-[11px] text-white/50 leading-snug">{acc.probe.note}</p>
                  )}
                  {acc.probe.testedAt && (
                    <p className="text-[10px] text-white/30">{acc.probe.testedAt}</p>
                  )}
                </div>
              </div>

              {/* Metrics */}
              <div className="px-3 pb-2 space-y-1 border-t border-white/8 pt-2 flex-1">
                <div className="flex items-center gap-2 text-[12px] py-0.5">
                  <span className="text-white/45 shrink-0">健康状态（周限）</span>
                  <HealthDots percent={acc.weeklyPercent} />
                  <span className="text-white/50 tabular-nums shrink-0 min-w-[2rem] text-right text-[12px]">
                    {acc.weeklyPercent == null ? "—" : `${Math.round(acc.weeklyPercent)}%`}
                  </span>
                </div>

                <MetricBlock
                  label="周限额"
                  value={weeklyText}
                  barPercent={acc.weeklyPercent}
                  muted={acc.weeklyPercent == null}
                />
                <MetricBlock
                  label="Build 用量"
                  value={buildText}
                  barPercent={acc.buildPercent}
                  muted={acc.buildPercent == null}
                />
                <MetricBlock
                  label={apiLabel}
                  value={apiText}
                  muted={acc.apiUsed == null}
                />
                <MetricBlock label="按量已用" value={acc.onDemandText} muted />
                {acc.parseSummary && (
                  <p className="text-[10px] text-white/25 leading-snug pt-0.5 break-all">
                    {acc.parseSummary}
                  </p>
                )}
                <MetricBlock
                  label="按量付费"
                  value={acc.payAsYouGo}
                  muted={acc.payAsYouGo === "未启用"}
                />
              </div>

              {/* Footer */}
              <div className="flex items-center gap-0.5 px-2 py-2 border-t border-white/8 bg-black/30 mt-auto">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-7 gap-1 text-[11px] text-white/70 hover:text-white hover:bg-white/10"
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
                  className="h-7 w-7 text-white/60 hover:text-white hover:bg-white/10"
                  onClick={() => onRetry?.()}
                  title="刷新"
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7 w-7 text-white/60 hover:text-white hover:bg-white/10"
                  onClick={() => onOpenSettings?.()}
                  title="账号设置"
                >
                  <Settings className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="h-7 w-7 text-red-400/90 hover:text-red-300 hover:bg-red-500/15"
                  disabled={busyKey === acc.entryKey}
                  onClick={() => void removeAccount(acc.entryKey)}
                  title="删除账号"
                >
                  <Trash2 className="size-3.5" />
                </Button>
                <div className="flex-1" />
                <label className="flex items-center gap-1.5 text-[11px] text-white/45 select-none pr-1">
                  启用
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isTray}
                    disabled={busyKey === acc.entryKey}
                    onClick={() => void setEnabled(acc.entryKey, !isTray)}
                    className={cn(
                      "relative h-5 w-9 rounded-full transition-colors",
                      isTray ? "bg-white" : "bg-white/20"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 left-0.5 h-4 w-4 rounded-full shadow transition-transform",
                        isTray ? "translate-x-4 bg-black" : "bg-white"
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
