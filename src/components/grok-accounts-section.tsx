import { useCallback, useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type GrokAccountSummary = {
  entryKey: string
  email?: string | null
  emailMasked: string
  labels: string[]
  subscriptionPaste?: string | null
  subscriptionDisplay?: string | null
  expired: boolean
}

type DeviceLoginStart = {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string | null
  expiresIn: number
  interval: number
  copyUrl: string
}

type DeviceLoginStatus = {
  state: string
  message?: string | null
  entryKey?: string | null
  emailMasked?: string | null
}

type GrokAccountsSectionProps = {
  onAccountsChanged?: () => void
}

function LabelChips({
  labels,
  onChange,
  disabled,
}: {
  labels: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const t = draft.trim().slice(0, 32)
    if (!t) return
    if (labels.includes(t)) {
      setDraft("")
      return
    }
    if (labels.length >= 8) return
    onChange([...labels, t])
    setDraft("")
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {labels.map((lb) => (
          <span
            key={lb}
            className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px]"
          >
            {lb}
            <button
              type="button"
              className="opacity-60 hover:opacity-100"
              disabled={disabled}
              aria-label={`删除标签 ${lb}`}
              onClick={() => onChange(labels.filter((x) => x !== lb))}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {labels.length === 0 && (
          <span className="text-[11px] text-muted-foreground">暂无标签</span>
        )}
      </div>
      <div className="flex gap-1">
        <input
          className="flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          value={draft}
          disabled={disabled || labels.length >= 8}
          placeholder="输入标签后回车"
          maxLength={32}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={disabled} onClick={add}>
          添加
        </Button>
      </div>
    </div>
  )
}

function SortableAccountRow({
  account,
  paste,
  labels,
  saving,
  onLabelsChange,
  onPasteChange,
  onSave,
}: {
  account: GrokAccountSummary
  paste: string
  labels: string[]
  saving: boolean
  onLabelsChange: (labels: string[]) => void
  onPasteChange: (paste: string) => void
  onSave: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: account.entryKey,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-lg border bg-muted/30 p-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground hover:text-foreground"
            aria-label="拖动排序"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {account.emailMasked}
              {account.expired && (
                <span className="ml-2 text-xs text-destructive">已过期</span>
              )}
            </div>
            {account.subscriptionDisplay && (
              <div className="text-xs text-muted-foreground">
                续费：{account.subscriptionDisplay}
              </div>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">标签（最多 8 个，点 × 删除）</span>
        <LabelChips labels={labels} onChange={onLabelsChange} disabled={saving} />
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          订阅续费粘贴（如 Renews on July 18, 2026 · billed via Google Play）
        </span>
        <textarea
          className="w-full min-h-[56px] rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring resize-y"
          value={paste}
          disabled={saving}
          placeholder="Renews on July 18, 2026 · billed via Google Play"
          onChange={(e) => onPasteChange(e.target.value)}
        />
      </label>
    </div>
  )
}

export function GrokAccountsSection({ onAccountsChanged }: GrokAccountsSectionProps) {
  const [accounts, setAccounts] = useState<GrokAccountSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [labelMap, setLabelMap] = useState<Record<string, string[]>>({})
  const [pasteMap, setPasteMap] = useState<Record<string, string>>({})

  const [login, setLogin] = useState<DeviceLoginStart | null>(null)
  const [loginStatus, setLoginStatus] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const loadAccounts = useCallback(async () => {
    if (!isTauri()) return
    setLoading(true)
    setError(null)
    try {
      const list = await invoke<GrokAccountSummary[]>("grok_list_accounts")
      setAccounts(list)
      const labels: Record<string, string[]> = {}
      const pastes: Record<string, string> = {}
      for (const a of list) {
        labels[a.entryKey] = [...(a.labels || [])]
        pastes[a.entryKey] = a.subscriptionPaste || ""
      }
      setLabelMap(labels)
      setPasteMap(pastes)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAccounts()
    return () => stopPolling()
  }, [loadAccounts, stopPolling])

  const saveAccount = async (entryKey: string) => {
    if (!isTauri()) return
    setSavingKey(entryKey)
    setError(null)
    try {
      await invoke("grok_update_account_meta", {
        update: {
          entryKey,
          labels: labelMap[entryKey] || [],
          subscriptionPaste: pasteMap[entryKey] || "",
        },
      })
      await loadAccounts()
      onAccountsChanged?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setSavingKey(null)
    }
  }

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = accounts.findIndex((a) => a.entryKey === active.id)
    const newIndex = accounts.findIndex((a) => a.entryKey === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(accounts, oldIndex, newIndex)
    setAccounts(next)
    try {
      await invoke("grok_reorder_accounts", {
        orderedKeys: next.map((a) => a.entryKey),
      })
      onAccountsChanged?.()
    } catch (e) {
      setError(String(e))
      void loadAccounts()
    }
  }

  const logoutAll = async () => {
    if (!isTauri()) return
    if (
      !window.confirm(
        "确定退出全部 Grok 账号？将清空本机 ~/.grok/auth.json 中的全部条目（不可恢复）。"
      )
    ) {
      return
    }
    setError(null)
    try {
      const n = await invoke<number>("grok_logout_all")
      setLoginStatus(`已退出 ${n} 个账号`)
      await loadAccounts()
      onAccountsChanged?.()
    } catch (e) {
      setError(String(e))
    }
  }

  const softImport = async () => {
    if (!isTauri()) return
    try {
      const n = await invoke<number>("grok_soft_import_cli")
      setLoginStatus(`已同步 CLI 账号元数据（${n} 个）`)
      await loadAccounts()
      onAccountsChanged?.()
    } catch (e) {
      setError(String(e))
    }
  }

  const startLogin = async () => {
    if (!isTauri()) return
    setLoginBusy(true)
    setError(null)
    setLoginStatus(null)
    stopPolling()
    try {
      const started = await invoke<DeviceLoginStart>("grok_start_device_login")
      setLogin(started)
      setLoginStatus("已生成登录码。请复制链接，在浏览器中打开并确认。")
      try {
        await writeText(started.copyUrl)
        setLoginStatus("登录链接已复制到剪贴板。在浏览器打开并完成授权。")
      } catch {
        // optional
      }

      const intervalMs = Math.max(3, started.interval || 5) * 1000
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const st = await invoke<DeviceLoginStatus>("grok_poll_device_login")
            if (st.message) setLoginStatus(st.message)
            if (st.state === "complete") {
              stopPolling()
              setLogin(null)
              setLoginStatus(
                st.emailMasked ? `登录成功：${st.emailMasked}` : "登录成功"
              )
              await loadAccounts()
              onAccountsChanged?.()
              setLoginBusy(false)
            } else if (
              st.state === "expired" ||
              st.state === "error" ||
              st.state === "cancelled"
            ) {
              stopPolling()
              setLoginBusy(false)
              if (st.state !== "cancelled") {
                setLoginStatus(st.message || "登录结束")
              }
            }
          } catch (e) {
            stopPolling()
            setLoginBusy(false)
            setError(String(e))
          }
        })()
      }, intervalMs)
    } catch (e) {
      setError(String(e))
      setLoginBusy(false)
    }
  }

  const cancelLogin = async () => {
    stopPolling()
    try {
      await invoke("grok_cancel_device_login")
    } catch {
      // ignore
    }
    setLogin(null)
    setLoginBusy(false)
    setLoginStatus("已取消登录")
  }

  const copyLoginLink = async () => {
    if (!login) return
    try {
      await writeText(login.copyUrl)
      setLoginStatus("登录链接已复制")
    } catch (e) {
      setError("复制失败: " + String(e))
    }
  }

  if (!isTauri()) return null

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold mb-0">Grok 账号</h3>
        <p className="text-sm text-muted-foreground mb-2">
          多账号管理：拖拽排序、标签、续费粘贴、device-code 登录、退出全部
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={loginBusy}
          onClick={() => void startLogin()}
        >
          {loginBusy ? "等待授权…" : "添加 / 重新登录"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void loadAccounts()}>
          刷新列表
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void softImport()}>
          同步 CLI 账号
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onAccountsChanged?.()}
          title="对全部账号重新跑 billing/settings/chat"
        >
          一键测试全部
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={() => void logoutAll()}>
          退出全部
        </Button>
        {login && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => void copyLoginLink()}>
              复制登录链接
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void cancelLogin()}>
              取消
            </Button>
          </>
        )}
      </div>

      {login && (
        <div className="rounded-lg border bg-muted/40 p-3 space-y-1 text-sm">
          <div>
            验证码：{" "}
            <span className="font-mono font-semibold tracking-wider">{login.userCode}</span>
          </div>
          <div className="text-muted-foreground break-all text-xs">{login.copyUrl}</div>
        </div>
      )}

      {loginStatus && <p className="text-xs text-muted-foreground">{loginStatus}</p>}
      {error && <p className="text-xs text-destructive break-words">{error}</p>}

      {loading && accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          尚未发现本机账号。点「添加 / 重新登录」或先运行{" "}
          <code className="text-xs">grok login</code>，再点「同步 CLI 账号」。
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
          <SortableContext
            items={accounts.map((a) => a.entryKey)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {accounts.map((account) => (
                <SortableAccountRow
                  key={account.entryKey}
                  account={account}
                  labels={labelMap[account.entryKey] || []}
                  paste={pasteMap[account.entryKey] || ""}
                  saving={savingKey === account.entryKey}
                  onLabelsChange={(labels) =>
                    setLabelMap((prev) => ({ ...prev, [account.entryKey]: labels }))
                  }
                  onPasteChange={(paste) =>
                    setPasteMap((prev) => ({ ...prev, [account.entryKey]: paste }))
                  }
                  onSave={() => void saveAccount(account.entryKey)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <p className={cn("text-[10px] text-muted-foreground leading-relaxed")}>
        账号凭证保存在 <code className="text-[10px]">~/.grok/auth.json</code>
        （与 Grok CLI 兼容）；标签/排序/托盘选择保存在应用{" "}
        <code className="text-[10px]">plugins_data/grok/accounts-meta.json</code>
        ，写 meta 不会覆盖 CLI 登录文件。
      </p>
    </section>
  )
}
