import { useCallback, useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"

type AccountSummary = { entryKey: string; emailMasked: string; selected: boolean }

export function CodexAccountsSection({ onAccountsChanged }: { onAccountsChanged?: () => void }) {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)

  const load = useCallback(async () => {
    if (!isTauri()) return
    const request = ++sequence.current
    try {
      const result = await invoke<AccountSummary[]>("codex_list_accounts")
      if (!Array.isArray(result)) throw new Error("Invalid account list")
      if (request === sequence.current) setAccounts(result)
    } catch {
      if (request === sequence.current)
        setError("读取导入账号失败，请检查 Windows 用户和账号存储。")
    }
  }, [])

  useEffect(() => {
    void load()
    const picker = fileRef.current
    const resume = () => {
      if (isTauri()) void invoke("pause_panel_auto_hide", { paused: false }).catch(() => {})
    }
    picker?.addEventListener("cancel", resume)
    return () => {
      ++sequence.current
      picker?.removeEventListener("cancel", resume)
      resume()
    }
  }, [load])

  const importDocuments = async (documents: string[]) => {
    const count = await invoke<number>("codex_import_accounts", { documents })
    setDraft("")
    setMessage(`已导入 / 更新 ${count} 个账号，正在刷新用量。`)
    await load()
    onAccountsChanged?.()
  }

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      if (files.length > 20 || files.some((f) => f.size > 1024 * 1024))
        throw new Error("每次最多 20 个 JSON 文件，每个文件不超过 1 MiB。")
      await importDocuments(await Promise.all(files.map((file) => file.text())))
    } catch (e) {
      setError(
        typeof e === "string"
          ? e
          : "导入失败，请选择 CLIProxy 的 Codex OAuth 账号 JSON（最多 20 个，每个不超过 1 MiB）。"
      )
    } finally {
      setBusy(false)
    }
  }

  const importPaste = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      if (new TextEncoder().encode(draft).length > 1024 * 1024) throw new Error("too large")
      await importDocuments([draft])
    } catch (e) {
      setError(typeof e === "string" ? e : "导入失败，请检查 JSON 格式和大小。")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entryKey: string) => {
    if (!window.confirm("移除此应用中的导入账号？CLIProxy 原文件和本机 Codex 登录保持不变。"))
      return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await invoke("codex_remove_account", { entryKey })
      await load()
      onAccountsChanged?.()
      setMessage("已移除导入副本。")
    } catch {
      setError("移除失败，请刷新列表后重试。")
    } finally {
      setBusy(false)
    }
  }

  const openPicker = async () => {
    setError(null)
    try {
      await invoke("pause_panel_auto_hide", { paused: true })
      fileRef.current?.click()
    } catch {
      setError("打开文件选择器失败，请使用粘贴 JSON 导入。")
    }
  }
  const resumeHide = () => {
    void invoke("pause_panel_auto_hide", { paused: false }).catch(() => {})
  }

  if (!isTauri()) return null
  return (
    <section className="space-y-3" aria-label="ChatGPT / Codex 账号导入">
      <div>
        <h3 className="text-lg font-semibold">ChatGPT / Codex 账号</h3>
        <p className="text-sm text-muted-foreground">
          直接导入 CLIProxy 的 Codex OAuth 账号 JSON，支持多文件、JSON 数组或 accounts 数组。
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        从 CLIProxy 的 auth-dir 选择 Codex 账号文件，或使用面板导出的账号 JSON。config.yaml、API Key
        和仅含账号列表的元数据不适用于订阅额度查询。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void openPicker()}>
          {busy ? "处理中…" : "导入 CLIProxy JSON"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
          刷新导入列表
        </Button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        multiple
        className="hidden"
        aria-label="选择 CLIProxy Codex 账号文件"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          resumeHide()
          void importFiles(files)
        }}
      />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">粘贴 JSON 导入</summary>
        <label className="mt-2 block space-y-2">
          <span className="text-xs text-muted-foreground">凭据 JSON（导入成功后清空）</span>
          <textarea
            aria-label="CLIProxy 账号 JSON"
            className="min-h-24 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
            value={draft}
            maxLength={1024 * 1024}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !draft.trim()}
          onClick={() => void importPaste()}
        >
          导入粘贴内容
        </Button>
      </details>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      )}
      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          暂无导入账号；本机 Codex 登录继续按原方式读取。
        </p>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div
              key={a.entryKey}
              className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2"
            >
              <span className="min-w-0 flex-1 truncate text-xs">
                {a.emailMasked}
                {a.selected ? " · 当前托盘" : ""}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() => void remove(a.entryKey)}
                aria-label={`移除 ${a.emailMasked}`}
              >
                移除
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        导入副本使用 Windows DPAPI 加密，保存在应用数据目录；不覆盖源文件。为避免与 CLIProxy
        争用刷新令牌，导入账号不主动续期，凭据到期后请重新导入最新 JSON。请在提供商插件中启用
        Codex。
      </p>
    </section>
  )
}
