import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { PanelFooter } from "@/components/panel-footer"
import type { UpdateStatus } from "@/hooks/use-app-update"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}))

const idle: UpdateStatus = { status: "idle" }
const noop = () => {}
const footerProps = { showAbout: false, onShowAbout: noop, onCloseAbout: noop, onUpdateCheck: noop }

describe("PanelFooter", () => {
  it("shows countdown in minutes when >= 60 seconds", () => {
    const futureTime = Date.now() + 5 * 60 * 1000 // 5 minutes from now
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={futureTime}
        updateStatus={idle}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(screen.getByText("5 分钟后刷新")).toBeTruthy()
  })

  it("shows countdown in seconds when < 60 seconds", () => {
    const futureTime = Date.now() + 30 * 1000 // 30 seconds from now
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={futureTime}
        updateStatus={idle}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(screen.getByText("30 秒后刷新")).toBeTruthy()
  })

  it("triggers refresh when clicking countdown label", async () => {
    const futureTime = Date.now() + 5 * 60 * 1000 // 5 minutes from now
    const onRefreshAll = vi.fn()
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={futureTime}
        updateStatus={idle}
        onUpdateInstall={noop}
        onRefreshAll={onRefreshAll}
        {...footerProps}
      />
    )
    const button = screen.getByRole("button", { name: /分钟后刷新|秒后刷新/i })
    await userEvent.click(button)
    expect(onRefreshAll).toHaveBeenCalledTimes(1)
  })

  it("shows Paused when autoUpdateNextAt is null", () => {
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={idle}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(screen.getByText("已暂停")).toBeTruthy()
  })

  it("shows downloading state", () => {
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={{ status: "downloading", progress: 42 }}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(screen.getByText("正在下载更新 42%")).toBeTruthy()
  })

  it("shows downloading state without percentage when progress is unknown", () => {
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={{ status: "downloading", progress: -1 }}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(screen.getByText("正在下载更新…")).toBeTruthy()
  })

  it("shows restart button when ready", async () => {
    const onInstall = vi.fn()
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={{ status: "ready" }}
        onUpdateInstall={onInstall}
        {...footerProps}
      />
    )
    const button = screen.getByText("重启以更新")
    expect(button).toBeTruthy()
    await userEvent.click(button)
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it("shows retryable updates soon state for update check failures", async () => {
    const onUpdateCheck = vi.fn()
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={{ status: "error", message: "Update check failed" }}
        onUpdateInstall={noop}
        showAbout={false}
        onShowAbout={noop}
        onCloseAbout={noop}
        onUpdateCheck={onUpdateCheck}
      />
    )

    const retryButton = screen.getByRole("button", { name: "即将检查更新" })
    expect(retryButton).toBeTruthy()
    await userEvent.click(retryButton)
    expect(onUpdateCheck).toHaveBeenCalledTimes(1)
  })

  it("shows error state for non-check failures", () => {
    const { container } = render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={{ status: "error", message: "Download failed" }}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(container.textContent).toContain("更新失败")
    expect(screen.queryByRole("button", { name: "即将检查更新" })).toBeNull()
  })

  it("shows installing state", () => {
    render(
      <PanelFooter
        version="0.0.0"
        autoUpdateNextAt={null}
        updateStatus={{ status: "installing" }}
        onUpdateInstall={noop}
        {...footerProps}
      />
    )
    expect(screen.getByText("正在安装…")).toBeTruthy()
  })

  it("opens About dialog when clicking version in idle state", async () => {
    function Harness() {
      const [showAbout, setShowAbout] = useState(false)
      return (
        <PanelFooter
          version="0.0.0"
          autoUpdateNextAt={null}
          updateStatus={idle}
          onUpdateInstall={noop}
          showAbout={showAbout}
          onShowAbout={() => setShowAbout(true)}
          onCloseAbout={() => setShowAbout(false)}
          onUpdateCheck={noop}
        />
      )
    }

    render(<Harness />)
    await userEvent.click(screen.getByRole("button", { name: /OpenUsage/ }))
    expect(screen.getByText("Windows 版")).toBeInTheDocument()

    // Close via Escape to exercise AboutDialog onClose path.
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText("Windows 版")).not.toBeInTheDocument()
  })
})
