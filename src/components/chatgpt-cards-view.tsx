import { useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  AlertCircle,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  Settings,
  Trash2,
  Upload
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { HealthDots, MetricBlock, ThinBar, formatClock } from "@/components/usage-card-parts"
import { UsageSparkline } from "@/components/usage-sparkline"
import type { MetricLine } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"
import { getTimeFormatter } from "@/lib/reset-tooltip"
import { cn } from "@/lib/utils"
import codexIcon from "../../plugins/codex/icon.svg"

export type ChatgptAccountCard = {
  entryKey: string
  title: string
  source: string
  plan: string | null
  lines: MetricLine[]
  error: string | null
}

export type ChatgptPayload = {
  v: 1
  accounts: ChatgptAccountCard[]
  trayEntryKey: string
}

export function extractChatgptPayload(lines: MetricLine[]): ChatgptPayload | null {
  const line = lines.find((l) => l.type === "text" && l.label === "__chatgpt_v1")
  if (!line || line.type !== "text") return null
  try {
    const data = JSON.parse(line.value) as ChatgptPayload
    if (data.v !== 1 || !Array.isArray(data.accounts)) return null
    if (
      !data.accounts.every(
        (a) =>
          a &&
          typeof a.entryKey === "string" &&
          typeof a.title === "string" &&
          Array.isArray(a.lines)
      )
    )
      return null
    return data
  } catch {
    return null
  }
}

const labels: Record<string, string> = {
  Session: "会话限额",
  Weekly: "周限额",
  Reviews: "代码审查",
  Spark: "Spark 限额",
  "Spark Weekly": "Spark 周限额",
  Credits: "额外积分",
  "Rate Limit Resets": "额度重置次数",
  Today: "本机今日",
  Yesterday: "本机昨日",
  "Last 30 Days": "本机近 30 天",
  Status: "状态"
}

export function quotaPercent(line: MetricLine | undefined): number | null {
  if (
    !line ||
    line.type !== "progress" ||
    !Number.isFinite(line.used) ||
    !Number.isFinite(line.limit) ||
    line.limit <= 0
  )
    return null
  return Math.max(0, Math.min(100, (line.used / line.limit) * 100))
}

const actionClass =
  "h-7 gap-1 border-white/15 bg-white/5 text-[11px] text-white/80 hover:bg-white/10 hover:text-white"
const iconClass = "h-7 w-7 text-white/60 hover:bg-white/10 hover:text-white"

function quotaResetLabel(
  now: number,
  resetsAt: string,
  mode: ResetTimerDisplayMode,
  timeFormat: TimeFormatMode
): string | null {
  const reset = Date.parse(resetsAt)
  if (!Number.isFinite(reset)) return null
  const diff = reset - now
  if (diff <= 0 || (mode === "relative" && diff < 300_000)) return "即将重置"
  if (mode === "absolute") {
    const date = new Date(reset)
    return `重置 ${date.getMonth() + 1}/${date.getDate()} ${getTimeFormatter(timeFormat).format(date)}`
  }
  const minutes = Math.ceil(diff / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days > 0
    ? `距重置 ${days} 天 ${hours} 小时`
    : hours > 0
      ? `距重置 ${hours} 小时 ${minutes % 60} 分钟`
      : `距重置 ${minutes} 分钟`
}

type Props = {
  payload: ChatgptPayload
  loading?: boolean
  error?: string | null
  refreshDisabled?: boolean
  refreshHint?: string
  lastUpdatedAt?: number | null
  autoUpdateNextAt?: number | null
  onRetry?: () => void
  onOpenSettings?: () => void
  onAccountsChanged?: () => void
  workbench?: boolean
  onToggleWorkbench?: () => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  now: number
}

export function ChatgptCardsView({
  payload,
  loading = false,
  error = null,
  refreshDisabled = false,
  refreshHint,
  lastUpdatedAt,
  autoUpdateNextAt,
  onRetry,
  onOpenSettings,
  onAccountsChanged,
  workbench = false,
  onToggleWorkbench,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode,
  onResetTimerDisplayModeToggle,
  now
}: Props) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [resetBusyKey, setResetBusyKey] = useState<string | null>(null)
  const [resetMessage, setResetMessage] = useState<string | null>(null)
  const [resetDone, setResetDone] = useState<string[]>([])
  const [pendingReset, setPendingReset] = useState<string[]>([])
  const resetLock = useRef(false)

  useEffect(() => {
    setResetDone([])
  }, [lastUpdatedAt])

  const useResetCredit = async (account: ChatgptAccountCard) => {
    if (!isTauri() || resetLock.current || busy || loading) return
    resetLock.current = true
    setResetBusyKey(account.entryKey)
    setActionError(null)
    setResetMessage(null)
    let submitted = false
    try {
      const prepared = await invoke<{ identity: string; availableCount: number; pending: boolean }>(
        "codex_prepare_reset",
        { entryKey: account.entryKey }
      )
      if (!prepared.pending && prepared.availableCount === 0) {
        setResetMessage("当前没有可用的重置卡，正在刷新数量。")
        onAccountsChanged?.()
        return
      }
      await invoke("pause_panel_auto_hide", { paused: true })
      const confirmed = window.confirm(
        prepared.pending
          ? `核对 ${account.title} 上次未完成的重置请求？将复用原请求编号，不发起新的重置。`
          : `确定为 ${account.title} 使用 1 张额度重置卡？当前可用 ${prepared.availableCount} 张。此操作会消耗该账号的重置卡，由服务端决定可重置的额度窗口。`
      )
      if (!confirmed) return
      submitted = true
      const result = await invoke<{ outcome: string; message: string }>("codex_consume_reset", {
        entryKey: account.entryKey,
        expectedIdentity: prepared.identity
      })
      setResetMessage(result.message)
      setPendingReset((keys) => keys.filter((key) => key !== account.entryKey))
      setResetDone((keys) => [...keys, account.entryKey])
      onAccountsChanged?.()
    } catch (e) {
      if (submitted) setPendingReset((keys) => [...new Set([...keys, account.entryKey])])
      setActionError(typeof e === "string" ? e : "读取或使用重置卡失败，请先刷新后重试。")
    } finally {
      void invoke("pause_panel_auto_hide", { paused: false }).catch(() => {})
      resetLock.current = false
      setResetBusyKey(null)
    }
  }

  const changeAccount = async (
    command: "codex_set_tray_account" | "codex_remove_account",
    entryKey: string
  ) => {
    if (!isTauri() || busy || loading || resetLock.current) return
    if (
      command === "codex_remove_account" &&
      !window.confirm("移除此应用中的导入账号？CLIProxy 原文件和本机 Codex 登录保持不变。")
    )
      return
    setBusy(true)
    setActionError(null)
    try {
      await invoke(command, { entryKey })
      onAccountsChanged?.()
    } catch {
      setActionError("账号操作失败，请到设置页刷新账号列表后重试。")
    } finally {
      setBusy(false)
    }
  }

  const openUsage = () => {
    setLinkError(null)
    void openUrl("https://chatgpt.com/codex/settings/usage").catch(() =>
      setLinkError("打开用量页面失败，请在浏览器访问 chatgpt.com/codex/settings/usage。")
    )
  }
  const accounts = payload.accounts
  const failures = accounts.filter((a) => a.error).length

  return (
    <section
      aria-label="ChatGPT 用量卡片"
      className="@container my-3 -mx-1 space-y-3 rounded-xl bg-[#0a0a0a] p-2 text-white [color-scheme:dark]"
    >
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5">
        <div className="min-w-0 flex-1 basis-40 text-[11px] leading-snug text-white/50">
          <span className="font-medium text-white/85">{accounts.length} 账号</span>
          <span className="mx-1.5 text-white/20">·</span>异常 {failures}
          <div className="mt-0.5">
            上次 {formatClock(lastUpdatedAt)} · 下次 {formatClock(autoUpdateNextAt)}
          </div>
        </div>
        <Button
          variant="outline"
          size="xs"
          className={actionClass}
          disabled={!onRetry || refreshDisabled}
          onClick={onRetry}
          title={refreshHint}
        >
          <RefreshCw
            className={cn("size-3.5", loading && "animate-spin motion-reduce:animate-none")}
          />
          {loading ? "刷新中…" : "刷新全部"}
        </Button>
        {onOpenSettings && (
          <Button variant="outline" size="xs" className={actionClass} onClick={onOpenSettings}>
            <Upload className="size-3.5" />
            导入
          </Button>
        )}
        {onToggleWorkbench && (
          <Button variant="outline" size="xs" className={actionClass} onClick={onToggleWorkbench}>
            {workbench ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            {workbench ? "收起工作台" : "展开工作台"}
          </Button>
        )}
      </div>

      {(error || actionError || linkError) && (
        <div
          role="alert"
          className="flex gap-1.5 rounded-lg border border-red-900/50 bg-[#2a1214] p-2.5 text-[11px] text-red-200/90"
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="break-words min-w-0">
            {actionError || linkError || error}
            {lastUpdatedAt && error ? " · 保留上次数据" : ""}
          </span>
        </div>
      )}
      {resetMessage && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-200"
        >
          {resetMessage}
        </p>
      )}

      {accounts.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-white/50">
          暂无账号，请导入 CLIProxy JSON 或登录本机 Codex。
        </p>
      )}

      <div
        className={cn(
          "grid gap-3",
          accounts.length >= 3
            ? "grid-cols-1 @min-[560px]:grid-cols-2 @min-[1040px]:grid-cols-3"
            : accounts.length > 1
              ? "grid-cols-1 @min-[560px]:grid-cols-2"
              : "grid-cols-1"
        )}
      >
        {accounts.map((account) => {
          const progress = account.lines.filter((l) => l.type === "progress")
          const weekly = progress.find((l) => l.label === "Weekly")
          const weeklyPercent = quotaPercent(weekly)
          const exhausted = progress.some((l) => quotaPercent(l) === 100)
          const hasQuota = progress.some((l) => quotaPercent(l) != null)
          const status = account.error
            ? "查询失败"
            : loading
              ? "刷新中"
              : exhausted
                ? "额度已满"
                : hasQuota
                  ? "正常"
                  : "暂无额度数据"
          const isTray = payload.trayEntryKey === account.entryKey
          const extras = account.lines.filter(
            (l) =>
              l.type !== "progress" && l.label !== "__chatgpt_v1" && l.label !== "Rate Limit Resets"
          )
          const resetLine = account.lines.find(
            (line) => line.type === "text" && line.label === "Rate Limit Resets"
          )
          const resetCount =
            resetLine?.type === "text" && /^\d+ available$/.test(resetLine.value)
              ? Number.parseInt(resetLine.value, 10)
              : null
          const hasPending = pendingReset.includes(account.entryKey)
          return (
            <article
              key={account.entryKey}
              aria-label={account.title}
              className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#121212] shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
            >
              <header className="space-y-2 px-3 pb-2 pt-3">
                <div className="flex items-start gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black">
                    <img src={codexIcon} alt="" className="size-6 brightness-0 invert" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1 text-[10px]">
                      <span className="rounded border border-white/15 px-1.5 py-0.5 font-semibold text-white/70">
                        OpenAI
                      </span>
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5",
                          account.error
                            ? "border-red-500/40 bg-red-500/10 text-red-300"
                            : exhausted
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                              : hasQuota
                                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                                : "border-white/15 text-white/50"
                        )}
                      >
                        {status}
                      </span>
                      {account.plan && (
                        <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-white/65">
                          {account.plan}
                        </span>
                      )}
                    </div>
                    <h2
                      className="mt-1 truncate text-[15px] font-semibold leading-tight"
                      title={account.title}
                    >
                      {account.title}
                    </h2>
                    <p className="mt-1 text-[11px] text-white/40">
                      ChatGPT / Codex · {account.source}
                    </p>
                  </div>
                </div>
                <p className="text-[11px] text-white/45">
                  Codex 订阅用量 · 刷新 {formatClock(lastUpdatedAt)}
                </p>
                {account.error && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-900/50 bg-[#2a1214] px-2.5 py-2 text-[11px] text-red-200/90 break-words"
                  >
                    {account.error}
                    {account.lines.length > 0 ? " · 保留上次数据" : ""}
                  </p>
                )}
                {loading && account.lines.length === 0 && !account.error && (
                  <div role="status" className="space-y-2 py-2 motion-safe:animate-pulse">
                    <div className="h-2 rounded bg-white/10" />
                    <div className="h-2 w-2/3 rounded bg-white/10" />
                    <span className="sr-only">正在读取订阅额度</span>
                  </div>
                )}
              </header>

              <div className="flex-1 space-y-2 border-t border-white/8 px-3 pb-3 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/8 bg-black/40 px-2.5 py-2">
                  <span className="text-[11px] text-white/50">
                    额度重置卡{" "}
                    <span className="ml-1 tabular-nums text-white/85">
                      {resetCount == null ? "待查询" : `${resetCount} 张`}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className={actionClass}
                    disabled={
                      !isTauri() ||
                      busy ||
                      resetBusyKey !== null ||
                      loading ||
                      Boolean(account.error) ||
                      resetDone.includes(account.entryKey) ||
                      (resetCount === 0 && !hasPending)
                    }
                    aria-label={`${hasPending ? "核对重置结果" : "使用重置卡"} ${account.title}`}
                    onClick={() => void useResetCredit(account)}
                  >
                    {resetBusyKey === account.entryKey
                      ? "处理中…"
                      : resetDone.includes(account.entryKey)
                        ? "等待刷新"
                        : hasPending
                          ? "核对重置结果"
                          : resetCount === 0
                            ? "无可用重置卡"
                            : resetCount == null
                              ? "查看重置卡"
                              : "使用重置卡"}
                  </Button>
                </div>
                <div
                  className="flex items-center gap-2 py-0.5 text-[12px]"
                  aria-label={
                    weeklyPercent == null
                      ? "周额度余量未知"
                      : `周额度剩余 ${Math.round(100 - weeklyPercent)}%`
                  }
                >
                  <span className="shrink-0 text-white/45">周额度余量</span>
                  <HealthDots percent={weeklyPercent} />
                  <span className="shrink-0 tabular-nums text-white/65">
                    {weeklyPercent == null ? "—" : `${Math.round(100 - weeklyPercent)}%`}
                  </span>
                </div>
                <div
                  className={cn(
                    "grid gap-x-5 gap-y-2",
                    workbench && accounts.length === 1 && "@min-[560px]:grid-cols-2"
                  )}
                >
                  {progress.map((line, index) => {
                    if (line.type !== "progress") return null
                    const percent = quotaPercent(line)
                    const displayPercent =
                      percent == null ? null : displayMode === "left" ? 100 - percent : percent
                    const resetLabel = line.resetsAt
                      ? quotaResetLabel(now, line.resetsAt, resetTimerDisplayMode, timeFormatMode)
                      : null
                    return (
                      <div key={`${line.label}-${index}`} className="min-w-0 py-0.5">
                        <div className="flex items-baseline justify-between gap-2 text-[12px] leading-5">
                          <span className="text-white/45">{labels[line.label] || line.label}</span>
                          <span className="shrink-0 tabular-nums text-white/85">
                            {percent == null
                              ? "暂无数据"
                              : `${displayMode === "left" ? "剩余" : "已用"} ${Math.round(displayPercent!)}%`}
                          </span>
                        </div>
                        <ThinBar
                          percent={displayPercent}
                          color={percent != null && percent >= 100 ? "#fbbf24" : undefined}
                        />
                        {resetLabel && (
                          <button
                            type="button"
                            disabled={!onResetTimerDisplayModeToggle}
                            onClick={onResetTimerDisplayModeToggle}
                            className="mt-1 block max-w-full truncate text-left text-[10px] text-white/40 disabled:opacity-100"
                            title={line.resetsAt}
                            aria-label={`切换${labels[line.label] || line.label}重置时间显示`}
                          >
                            {resetLabel}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                {!hasQuota && !loading && (
                  <p className="text-[11px] text-white/40">
                    {account.error ? "修复登录或重新导入后刷新用量。" : "接口暂未返回额度数据。"}
                  </p>
                )}
                {extras.length > 0 && (
                  <div className="space-y-1 rounded-xl border border-white/8 bg-black/40 px-2.5 py-2">
                    {extras.map((line, index) =>
                      line.type === "barChart" ? (
                        <UsageSparkline
                          key={index}
                          {...line}
                          label="本机用量趋势"
                          color="#34d399"
                        />
                      ) : line.type === "text" || line.type === "badge" ? (
                        <div key={index}>
                          <MetricBlock
                            label={labels[line.label] || line.label}
                            value={line.type === "text" ? line.value : line.text}
                          />
                          {line.subtitle && (
                            <p className="text-right text-[10px] text-white/40">{line.subtitle}</p>
                          )}
                        </div>
                      ) : null
                    )}
                  </div>
                )}
              </div>

              <footer className="mt-auto flex flex-wrap items-center gap-0.5 border-t border-white/8 bg-black/30 px-2 py-2">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={iconClass}
                  aria-label={`刷新 ${account.title}（刷新全部账号）`}
                  disabled={!onRetry || refreshDisabled}
                  title={refreshHint || "刷新全部账号用量"}
                  onClick={onRetry}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                {onOpenSettings && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={iconClass}
                    aria-label={`设置 ${account.title}`}
                    onClick={onOpenSettings}
                  >
                    <Settings className="size-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={iconClass}
                  aria-label={`打开 ${account.title} 用量页面`}
                  onClick={openUsage}
                >
                  <ExternalLink className="size-3.5" />
                </Button>
                {account.entryKey !== "local" && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="h-7 w-7 text-red-400/90 hover:bg-red-500/15 hover:text-red-300"
                    disabled={busy || loading || !isTauri()}
                    aria-label={`移除 ${account.title}`}
                    onClick={() => void changeAccount("codex_remove_account", account.entryKey)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
                <div className="flex-1" />
                <button
                  type="button"
                  className="px-1 text-[11px] text-white/50 disabled:opacity-60"
                  disabled={busy || loading || isTray || !isTauri()}
                  onClick={() => void changeAccount("codex_set_tray_account", account.entryKey)}
                  aria-label={`设为托盘账号 ${account.title}`}
                  aria-pressed={isTray}
                >
                  {isTray ? "● 当前托盘" : "设为托盘"}
                </button>
              </footer>
            </article>
          )
        })}
      </div>
    </section>
  )
}
