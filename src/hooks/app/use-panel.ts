import { useCallback, useEffect, useRef, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  currentMonitor,
} from "@tauri-apps/api/window"
import type { ActiveView } from "@/components/side-nav"
import type { DisplayPluginState } from "@/hooks/app/use-app-plugin-views"

const PANEL_WIDTH = 400
const MAX_HEIGHT_FALLBACK_PX = 600
const MAX_HEIGHT_FRACTION_OF_MONITOR = 0.8

type UsePanelArgs = {
  activeView: ActiveView
  setActiveView: (view: ActiveView) => void
  showAbout: boolean
  setShowAbout: (value: boolean) => void
  displayPlugins: DisplayPluginState[]
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  if (target.isContentEditable) return true
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) {
    return true
  }

  return false
}

export function usePanel({
  activeView,
  setActiveView,
  showAbout,
  setShowAbout,
  displayPlugins,
}: UsePanelArgs) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const [maxPanelHeightPx, setMaxPanelHeightPx] = useState<number | null>(null)
  const maxPanelHeightPxRef = useRef<number | null>(null)
  const focusContainer = useCallback(() => {
    window.requestAnimationFrame(() => {
      containerRef.current?.focus({ preventScroll: true })
    })
  }, [])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        focusContainer()
      }
    }

    window.addEventListener("focus", focusContainer)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("focus", focusContainer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [focusContainer])

  useEffect(() => {
    if (!isTauri()) return
    invoke("init_panel").catch(console.error)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    if (showAbout) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("hide_panel")
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [showAbout])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    const unlisteners: (() => void)[] = []

    async function setup() {
      const u1 = await listen<string>("tray:navigate", (event) => {
        setActiveView(event.payload as ActiveView)
        focusContainer()
      })
      if (cancelled) {
        u1()
        return
      }
      unlisteners.push(u1)

      const u2 = await listen("tray:show-about", () => {
        setShowAbout(true)
        focusContainer()
      })
      if (cancelled) {
        u2()
        return
      }
      unlisteners.push(u2)
    }

    void setup()

    return () => {
      cancelled = true
      for (const fn of unlisteners) fn()
    }
  }, [focusContainer, setActiveView, setShowAbout])

  useEffect(() => {
    if (showAbout) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
      if (isEditableTarget(event.target)) return

      const views: ActiveView[] = ["home", ...displayPlugins.map((plugin) => plugin.meta.id)]
      if (views.length === 0) return

      let nextView: ActiveView | undefined

      if (activeView === "settings") {
        nextView = event.key === "ArrowUp" ? views[views.length - 1] : views[0]
      } else {
        const currentIndex = views.indexOf(activeView)
        if (currentIndex === -1) return
        const offset = event.key === "ArrowUp" ? -1 : 1
        nextView = views[(currentIndex + offset + views.length) % views.length]
      }

      if (!nextView || nextView === activeView) return

      event.preventDefault()
      setActiveView(nextView)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeView, displayPlugins, setActiveView, showAbout])

  useEffect(() => {
    if (!isTauri()) return
    const container = containerRef.current
    if (!container) return

    // Serialize resizes: concurrent ResizeObserver callbacks used to interleave
    // setSize + delta setPosition and fling the panel to the top of the screen.
    let cancelled = false
    let running = false
    let pending = false

    const applyResize = async () => {
      const factor = window.devicePixelRatio || 1
      const width = Math.ceil(PANEL_WIDTH * factor)
      const desiredHeightLogical = Math.max(1, container.scrollHeight)

      let maxHeightPhysical: number | null = null
      let maxHeightLogical: number | null = null

      try {
        const monitor = await currentMonitor()
        if (monitor) {
          maxHeightPhysical = Math.floor(monitor.size.height * MAX_HEIGHT_FRACTION_OF_MONITOR)
          maxHeightLogical = Math.floor(maxHeightPhysical / factor)
        }
      } catch {
        // fall through to fallback
      }

      if (maxHeightLogical === null || maxHeightPhysical === null) {
        const screenAvailHeight = Number(window.screen?.availHeight) || MAX_HEIGHT_FALLBACK_PX
        maxHeightLogical = Math.floor(screenAvailHeight * MAX_HEIGHT_FRACTION_OF_MONITOR)
        maxHeightPhysical = Math.floor(maxHeightLogical * factor)
      }

      if (maxPanelHeightPxRef.current !== maxHeightLogical) {
        maxPanelHeightPxRef.current = maxHeightLogical
        setMaxPanelHeightPx(maxHeightLogical)
      }

      const desiredHeightPhysical = Math.ceil(desiredHeightLogical * factor)
      const height = Math.ceil(Math.min(desiredHeightPhysical, maxHeightPhysical))

      try {
        const currentWindow = getCurrentWindow()

        // Snapshot geometry BEFORE setSize — Windows keeps top-left fixed when
        // resizing, so we need the pre-resize origin for a correct bottom anchor.
        let previousHeight = height
        let previousPos: { x: number; y: number } | null = null
        try {
          const [size, pos] = await Promise.all([
            currentWindow.outerSize(),
            currentWindow.outerPosition(),
          ])
          previousHeight = size.height
          previousPos = { x: pos.x, y: pos.y }
        } catch {
          // ignore — reanchor below is the primary path
        }

        if (previousHeight !== height || previousPos === null) {
          await currentWindow.setSize(new PhysicalSize(width, height))
        } else {
          // Width may still need a DPI correction even when height is stable.
          try {
            const currentWidth = (await currentWindow.outerSize()).width
            if (currentWidth !== width) {
              await currentWindow.setSize(new PhysicalSize(width, height))
            }
          } catch {
            await currentWindow.setSize(new PhysicalSize(width, height))
          }
        }

        // Prefer re-snapping to the tray / taskbar (authoritative). Falls back to
        // bottom-edge delta if the tray rect is not available yet.
        try {
          await invoke("reanchor_panel")
        } catch {
          if (previousPos !== null) {
            const delta = previousHeight - height
            if (delta !== 0) {
              try {
                await currentWindow.setPosition(
                  new PhysicalPosition(previousPos.x, previousPos.y + delta)
                )
              } catch {
                // Positioning is best-effort; size is more important.
              }
            }
          }
        }
      } catch (e) {
        console.error("Failed to resize window:", e)
      }
    }

    const resizeWindow = () => {
      if (cancelled) return
      if (running) {
        pending = true
        return
      }
      running = true
      void (async () => {
        try {
          do {
            pending = false
            if (cancelled) return
            await applyResize()
          } while (pending && !cancelled)
        } finally {
          running = false
        }
      })()
    }

    resizeWindow()

    const observer = new ResizeObserver(() => {
      resizeWindow()
    })
    observer.observe(container)

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [activeView, displayPlugins])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const check = () => {
      setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 1)
    }

    check()
    el.addEventListener("scroll", check, { passive: true })

    const ro = new ResizeObserver(check)
    ro.observe(el)

    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true, subtree: true })

    return () => {
      el.removeEventListener("scroll", check)
      ro.disconnect()
      mo.disconnect()
    }
  }, [activeView])

  return {
    containerRef,
    scrollRef,
    canScrollDown,
    maxPanelHeightPx,
  }
}
