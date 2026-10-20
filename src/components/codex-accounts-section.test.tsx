import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { CodexAccountsSection } from "./codex-accounts-section"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }))

describe("CLIProxy import settings", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "codex_list_accounts" ? [] : command === "codex_import_accounts" ? 1 : undefined
    )
  })

  it("imports pasted JSON via native validation and clears the credential field", async () => {
    const changed = vi.fn()
    render(<CodexAccountsSection onAccountsChanged={changed} />)
    fireEvent.click(screen.getByText("粘贴 JSON 导入"))
    const draft = screen.getByRole("textbox", { name: "CLIProxy 账号 JSON" })
    const document = '{"type":"codex","access_token":"private-test"}'
    fireEvent.change(draft, { target: { value: document } })
    fireEvent.click(screen.getByRole("button", { name: "导入粘贴内容" }))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(invoke).toHaveBeenCalledWith("codex_import_accounts", { documents: [document] })
    expect(draft).toHaveValue("")
    expect(screen.getByRole("status")).toHaveTextContent("已导入 / 更新 1 个账号")
  })

  it("imports multiple files and releases the panel auto-hide lease", async () => {
    const changed = vi.fn()
    render(<CodexAccountsSection onAccountsChanged={changed} />)
    const files = ["a", "b"].map((id) => ({
      size: 128,
      text: async () => JSON.stringify({ type: "codex", access_token: id })
    }))
    fireEvent.change(screen.getByLabelText("选择 CLIProxy Codex 账号文件"), { target: { files } })
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(invoke).toHaveBeenCalledWith("codex_import_accounts", {
      documents: [
        JSON.stringify({ type: "codex", access_token: "a" }),
        JSON.stringify({ type: "codex", access_token: "b" })
      ]
    })
    expect(invoke).toHaveBeenCalledWith("pause_panel_auto_hide", { paused: false })
  })

  it("rejects oversized files without sending credentials to backend", async () => {
    render(<CodexAccountsSection />)
    fireEvent.change(screen.getByLabelText("选择 CLIProxy Codex 账号文件"), {
      target: { files: [{ size: 1024 * 1024 + 1 }] }
    })
    expect(await screen.findByRole("alert")).toHaveTextContent("最多 20 个")
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === "codex_import_accounts")
    ).toBe(false)
  })

  it("shows a safe native validation error and retains draft for correction", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "codex_import_accounts") throw "请选择 CLIProxy 的 Codex 账号 JSON"
      return []
    })
    render(<CodexAccountsSection />)
    fireEvent.click(screen.getByText("粘贴 JSON 导入"))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "{}" } })
    fireEvent.click(screen.getByRole("button", { name: "导入粘贴内容" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择 CLIProxy 的 Codex 账号 JSON")
    expect(screen.getByRole("textbox")).toHaveValue("{}")
  })

  it("does not show or access native credentials in a browser", () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const { container } = render(<CodexAccountsSection />)
    expect(container).toBeEmptyDOMElement()
    expect(invoke).not.toHaveBeenCalled()
  })
})
