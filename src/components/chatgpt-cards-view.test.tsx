import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke, isTauri } from "@tauri-apps/api/core"
import {
  ChatgptCardsView,
  extractChatgptPayload,
  quotaPercent,
  type ChatgptPayload
} from "./chatgpt-cards-view"
import { ProviderCard } from "./provider-card"
import type { MetricLine } from "@/lib/plugin-types"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }))

const weekly: MetricLine = {
  type: "progress",
  label: "Weekly",
  used: 24,
  limit: 100,
  format: { kind: "percent" },
  resetsAt: "2026-10-24T00:00:00Z"
}
const payload: ChatgptPayload = {
  v: 1,
  trayEntryKey: "import-1",
  accounts: [
    {
      entryKey: "import-1",
      title: "de***@example.com",
      source: "CLIProxy 导入",
      plan: "Plus",
      error: null,
      lines: [weekly, { type: "text", label: "Credits", value: "$3.20 · 80 credits" }]
    },
    {
      entryKey: "import-2",
      title: "te***@example.com",
      source: "CLIProxy 导入",
      plan: null,
      error: "凭据已过期，请重新导入 CLIProxy 的最新账号 JSON",
      lines: []
    }
  ]
}
const base = {
  payload,
  displayMode: "used" as const,
  resetTimerDisplayMode: "relative" as const,
  timeFormatMode: "24h" as const,
  now: Date.parse("2026-10-20T00:00:00Z")
}

describe("ChatGPT cards", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(false)
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it("isolates account errors and shows real quota, plan, source and credits", () => {
    render(<ChatgptCardsView {...base} />)
    expect(screen.getByText("2 账号")).toBeInTheDocument()
    const healthy = within(screen.getByRole("article", { name: payload.accounts[0].title }))
    expect(healthy.getByText("正常")).toBeInTheDocument()
    expect(healthy.getByText("Plus")).toBeInTheDocument()
    expect(healthy.getByText("已用 24%")).toBeInTheDocument()
    expect(healthy.getByLabelText("周额度剩余 76%")).toBeInTheDocument()
    expect(healthy.getByText("$3.20 · 80 credits")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("凭据已过期")
    expect(screen.queryByText(/billing/)).not.toBeInTheDocument()
  })

  it("confirms before consuming a reset credit and refreshes after success", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "codex_prepare_reset"
        ? { identity: "account-hash", availableCount: 1, pending: false }
        : command === "codex_consume_reset"
          ? { outcome: "reset", message: "额度重置成功，已使用 1 张重置卡，正在刷新用量。" }
          : undefined
    )
    const changed = vi.fn()
    const account = {
      ...payload.accounts[0],
      lines: [
        ...payload.accounts[0].lines,
        { type: "text" as const, label: "Rate Limit Resets", value: "1 available" }
      ]
    }
    render(
      <ChatgptCardsView
        {...base}
        payload={{ ...payload, accounts: [account] }}
        onAccountsChanged={changed}
      />
    )
    expect(screen.getByText("1 张")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: `使用重置卡 ${account.title}` }))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("使用 1 张额度重置卡"))
    expect(invoke).toHaveBeenCalledWith("codex_consume_reset", {
      entryKey: account.entryKey,
      expectedIdentity: "account-hash"
    })
    expect(screen.getByRole("status")).toHaveTextContent("额度重置成功")
    expect(screen.getByRole("button", { name: `使用重置卡 ${account.title}` })).toBeDisabled()
  })

  it("cancelling confirmation never consumes a reset card", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.spyOn(window, "confirm").mockReturnValue(false)
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "codex_prepare_reset"
        ? { identity: "hash", availableCount: 2, pending: false }
        : undefined
    )
    render(<ChatgptCardsView {...base} />)
    fireEvent.click(screen.getByRole("button", { name: `使用重置卡 ${payload.accounts[0].title}` }))
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalledOnce())
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === "codex_consume_reset")
    ).toBe(false)
  })

  it("revalidates availability and never POSTs without a credit", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.spyOn(window, "confirm").mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue({ identity: "hash", availableCount: 0, pending: false })
    render(<ChatgptCardsView {...base} />)
    fireEvent.click(screen.getByRole("button", { name: `使用重置卡 ${payload.accounts[0].title}` }))
    expect(await screen.findByRole("status")).toHaveTextContent("没有可用的重置卡")
    expect(window.confirm).not.toHaveBeenCalled()
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === "codex_consume_reset")
    ).toBe(false)
  })

  it("prevents duplicate clicks and provides pending-request recovery after timeout", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.spyOn(window, "confirm").mockReturnValue(true)
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "codex_prepare_reset")
        return { identity: "hash", availableCount: 1, pending: false }
      if (command === "codex_consume_reset") throw "重置请求结果待确认，请先刷新"
    })
    render(<ChatgptCardsView {...base} />)
    const button = screen.getByRole("button", { name: `使用重置卡 ${payload.accounts[0].title}` })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(
      await screen.findByRole("button", { name: `核对重置结果 ${payload.accounts[0].title}` })
    ).toBeEnabled()
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === "codex_consume_reset")
    ).toHaveLength(1)
    expect(screen.getAllByRole("alert").some((e) => e.textContent?.includes("结果待确认"))).toBe(
      true
    )
  })

  it("honors remaining mode and reset time toggle", () => {
    const toggle = vi.fn()
    render(<ChatgptCardsView {...base} displayMode="left" onResetTimerDisplayModeToggle={toggle} />)
    expect(screen.getByText("剩余 76%")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "切换周限额重置时间显示" }))
    expect(toggle).toHaveBeenCalledOnce()
  })

  it("connects refresh/import/workbench and disables refresh during cooldown", () => {
    const retry = vi.fn(),
      settings = vi.fn(),
      expand = vi.fn()
    const { rerender } = render(
      <ChatgptCardsView
        {...base}
        onRetry={retry}
        onOpenSettings={settings}
        onToggleWorkbench={expand}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "刷新全部" }))
    fireEvent.click(screen.getByRole("button", { name: "导入" }))
    fireEvent.click(screen.getByRole("button", { name: "展开工作台" }))
    expect(retry).toHaveBeenCalledOnce()
    expect(settings).toHaveBeenCalledOnce()
    expect(expand).toHaveBeenCalledOnce()
    rerender(<ChatgptCardsView {...base} onRetry={retry} refreshDisabled refreshHint="冷却中" />)
    expect(screen.getByRole("button", { name: "刷新全部" })).toBeDisabled()
  })

  it("selects tray account and confirms removal without touching CLI auth", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    const changed = vi.fn()
    vi.spyOn(window, "confirm").mockReturnValue(false)
    render(<ChatgptCardsView {...base} onAccountsChanged={changed} />)
    fireEvent.click(screen.getByRole("button", { name: `移除 ${payload.accounts[1].title}` }))
    expect(invoke).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    fireEvent.click(screen.getByRole("button", { name: `移除 ${payload.accounts[1].title}` }))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(invoke).toHaveBeenCalledWith("codex_remove_account", { entryKey: "import-2" })
    fireEvent.click(
      screen.getByRole("button", { name: `设为托盘账号 ${payload.accounts[1].title}` })
    )
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("codex_set_tray_account", { entryKey: "import-2" })
    )
  })

  it("does not call native account APIs in browser preview", () => {
    render(<ChatgptCardsView {...base} />)
    expect(screen.getByRole("button", { name: `移除 ${payload.accounts[0].title}` })).toBeDisabled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("handles missing, zero, exhausted and invalid quota without NaN", () => {
    expect(quotaPercent(weekly)).toBe(24)
    expect(quotaPercent({ ...weekly, used: 0 })).toBe(0)
    expect(quotaPercent({ ...weekly, used: 120 })).toBe(100)
    expect(quotaPercent({ ...weekly, limit: 0 })).toBeNull()
    expect(quotaPercent({ ...weekly, used: Number.NaN })).toBeNull()
    render(
      <ChatgptCardsView
        {...base}
        payload={{
          ...payload,
          accounts: [{ ...payload.accounts[0], lines: [{ ...weekly, used: 100 }] }]
        }}
      />
    )
    expect(screen.getByText("额度已满")).toBeInTheDocument()
    expect(screen.getByLabelText("周额度剩余 0%")).toBeInTheDocument()
  })

  it("validates machine payload and never dumps it as text", () => {
    const encode = (value: unknown): MetricLine[] => [
      { type: "text", label: "__chatgpt_v1", value: JSON.stringify(value) }
    ]
    expect(extractChatgptPayload(encode(payload))).toEqual(payload)
    for (const value of [null, {}, { v: 1, accounts: [null] }])
      expect(extractChatgptPayload(encode(value))).toBeNull()
    render(
      <ProviderCard providerId="codex" name="Codex" displayMode="used" lines={encode(payload)} />
    )
    expect(screen.getByLabelText("ChatGPT 用量卡片")).toBeInTheDocument()
    expect(screen.queryByText("__chatgpt_v1")).not.toBeInTheDocument()
  })

  it("uses the same card for local-only loading, stale errors, overview and detail", () => {
    const { rerender } = render(
      <ProviderCard providerId="codex" name="Codex" displayMode="used" loading />
    )
    expect(screen.getByRole("status")).toHaveTextContent("正在读取订阅额度")
    rerender(
      <ProviderCard
        providerId="codex"
        name="Codex"
        displayMode="used"
        scopeFilter="overview"
        lines={[weekly]}
        error="连接失败"
        lastUpdatedAt={Date.now()}
      />
    )
    expect(screen.getByRole("alert")).toHaveTextContent("连接失败")
    expect(screen.getByText("已用 24%")).toBeInTheDocument()
  })
})
