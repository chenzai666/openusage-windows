import { useCallback, useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { Button } from "@/components/ui/button"

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
  /** Called after meta save or successful login so Grok can re-probe. */
  onAccountsChanged?: () => void
}

export function GrokAccountsSection({ onAccountsChanged }: GrokAccountsSectionProps) {
  const [accounts, setAccounts] = useState<GrokAccountSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<
    Record<string, { labels: string; paste: string }>
  >({})

  const [login, setLogin] = useState<DeviceLoginStart | null>(null)
  const [loginStatus, setLoginStatus] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
      const next: Record<string, { labels: string; paste: string }> = {}
      for (const a of list) {
        next[a.entryKey] = {
          labels: (a.labels || []).join(", "),
          paste: a.subscriptionPaste || "",
        }
      }
      setDrafts(next)
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
    const draft = drafts[entryKey] || { labels: "", paste: "" }
    setSavingKey(entryKey)
    setError(null)
    try {
      const labels = draft.labels
        .split(/[,，;；]/g)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8)
      await invoke("grok_update_account_meta", {
        update: {
          entryKey,
          labels,
          subscriptionPaste: draft.paste,
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
        // clipboard optional
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
                st.emailMasked
                  ? `登录成功：${st.emailMasked}`
                  : "登录成功"
              )
              await loadAccounts()
              onAccountsChanged?.()
              setLoginBusy(false)
            } else if (st.state === "expired" || st.state === "error" || st.state === "cancelled") {
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

  if (!isTauri()) {
    return null
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold mb-0">Grok 账号</h3>
        <p className="text-sm text-muted-foreground mb-2">
          多账号标签、订阅续费粘贴、浏览器 device-code 登录（不自动打开浏览器）
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

      {loginStatus && (
        <p className="text-xs text-muted-foreground">{loginStatus}</p>
      )}

      {error && <p className="text-xs text-destructive break-words">{error}</p>}

      {loading && accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          尚未发现本机账号。可点「添加 / 重新登录」，或先运行{" "}
          <code className="text-xs">grok login</code>。
        </p>
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => {
            const draft = drafts[account.entryKey] || { labels: "", paste: "" }
            return (
              <div
                key={account.entryKey}
                className="rounded-lg border bg-muted/30 p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
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
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={savingKey === account.entryKey}
                    onClick={() => void saveAccount(account.entryKey)}
                  >
                    {savingKey === account.entryKey ? "保存中…" : "保存"}
                  </Button>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">
                    标签（逗号分隔，最多 8 个）
                  </span>
                  <input
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                    value={draft.labels}
                    placeholder="周02, 主力"
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [account.entryKey]: {
                          ...draft,
                          labels: e.target.value,
                        },
                      }))
                    }
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">
                    订阅续费粘贴（如 Renews on July 18, 2026 · billed via Google Play）
                  </span>
                  <textarea
                    className="w-full min-h-[56px] rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring resize-y"
                    value={draft.paste}
                    placeholder="Renews on July 18, 2026 · billed via Google Play"
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [account.entryKey]: {
                          ...draft,
                          paste: e.target.value,
                        },
                      }))
                    }
                  />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
