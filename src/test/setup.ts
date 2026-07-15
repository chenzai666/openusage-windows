import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

// Mock @aptabase/tauri globally — it calls window.__TAURI_IPC__ which doesn't exist in jsdom
vi.mock("@aptabase/tauri", () => ({
  trackEvent: vi.fn(),
}))

afterEach(() => {
  cleanup()
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver
}

// Base UI Checkbox constructs PointerEvent on click; jsdom does not provide it.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventMock extends MouseEvent {
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).PointerEvent = PointerEventMock
}

// Used by tray icon SVG rasterization in tests.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = vi.fn(() => "blob:mock-url") as typeof URL.createObjectURL
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
