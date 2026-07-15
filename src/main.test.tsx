import { describe, expect, it, vi } from "vitest"

const renderMock = vi.fn()
const createRootMock = vi.fn(() => ({ render: renderMock }))

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: createRootMock,
  },
  createRoot: createRootMock,
}))

vi.mock("@tauri-apps/plugin-log", () => ({
  error: vi.fn(() => Promise.resolve()),
  warn: vi.fn(() => Promise.resolve()),
  info: vi.fn(() => Promise.resolve()),
  debug: vi.fn(() => Promise.resolve()),
  trace: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/App", () => ({
  App: () => null,
}))

vi.mock("./App", () => ({
  App: () => null,
}))

describe("main", () => {
  it("mounts app", async () => {
    document.body.innerHTML = '<div id="root"></div>'
    await import("@/main")
    expect(createRootMock).toHaveBeenCalled()
    expect(renderMock).toHaveBeenCalled()
  })
})
