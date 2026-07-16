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
/** Ignore sub-pixel / DPI jitter so we don't fight the window manager. */
const SIZE_EPSILON_PX = 2
/** Coalesce rapid layout thrash when switching providers / probe results paint. */
const RESIZE_DEBOUNCE_MS = 48

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
  /** Physical Y of the panel's bottom edge — stays fixed while switching providers. */
  const bottomEdgePhysRef = useRef<number | null>(null)
  /** Latest scheduled resize entry point (set by the resize effect). */
  const scheduleResizeRef = useRef<(() => void) | null>(null)
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

      // Rust positions to the tray on show/toggle — drop the bottom lock so the
      // next content resize re-captures from the tray-aligned geometry.
      const u3 = await listen("tray:panel-shown", () => {
        bottomEdgePhysRef.current = null
        scheduleResizeRef.current?.()
      })
      if (cancelled) {
        u3()
        return
      }
      unlisteners.push(u3)
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

  // Size the native window to content. Keep the BOTTOM edge fixed so the panel
  // stays glued to the taskbar while switching AI providers (height changes a lot).
  // Do NOT re-query tray.rect() here — on Windows it is flaky and was flinging
  // the window to the top. Tray snap only happens in Rust on show/toggle.
  useEffect(() => {
    if (!isTauri()) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let running = false
    let pending = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const measureMaxHeight = async (): Promise<{ logical: number; physical: number }> => {
      const factor = window.devicePixelRatio || 1
      try {
        const monitor = await currentMonitor()
        if (monitor) {
          const physical = Math.floor(monitor.size.height * MAX_HEIGHT_FRACTION_OF_MONITOR)
          return { physical, logical: Math.floor(physical / factor) }
        }
      } catch {
        // fall through
      }
      const screenAvailHeight = Number(window.screen?.availHeight) || MAX_HEIGHT_FALLBACK_PX
      const logical = Math.floor(screenAvailHeight * MAX_HEIGHT_FRACTION_OF_MONITOR)
      return { logical, physical: Math.floor(logical * factor) }
    }

    const applyResize = async () => {
      if (cancelled || !containerRef.current) return
      const el = containerRef.current
      const factor = window.devicePixelRatio || 1
      const width = Math.ceil(PANEL_WIDTH * factor)
      const desiredHeightLogical = Math.max(1, el.scrollHeight)

      const maxH = await measureMaxHeight()
      if (cancelled) return

      if (maxPanelHeightPxRef.current !== maxH.logical) {
        maxPanelHeightPxRef.current = maxH.logical
        setMaxPanelHeightPx(maxH.logical)
      }

      const desiredHeightPhysical = Math.ceil(desiredHeightLogical * factor)
      const height = Math.ceil(Math.min(desiredHeightPhysical, maxH.physical))

      try {
        const currentWindow = getCurrentWindow()
        const [size, pos] = await Promise.all([
          currentWindow.outerSize(),
          currentWindow.outerPosition(),
        ])
        if (cancelled) return

        // Lock bottom edge the first time we see a real on-screen position.
        // Subsequent provider switches only move the top edge.
        if (bottomEdgePhysRef.current === null) {
          bottomEdgePhysRef.current = pos.y + size.height
        }

        const widthChanged = Math.abs(size.width - width) > SIZE_EPSILON_PX
        const heightChanged = Math.abs(size.height - height) > SIZE_EPSILON_PX
        if (!widthChanged && !heightChanged) {
          return
        }

        const bottom = bottomEdgePhysRef.current
        const nextY = Math.round(bottom - height)
        const nextX = pos.x

        // Size first (Windows keeps top-left), then snap top so bottom matches lock.
        await currentWindow.setSize(new PhysicalSize(width, height))
        if (cancelled) return
        await currentWindow.setPosition(new PhysicalPosition(nextX, nextY))
        if (cancelled) return

        // Re-assert the lock from our intended bottom (not OS-clamped drift),
        // unless the window was pushed fully off-monitor (then adopt OS result).
        try {
          const finalPos = await currentWindow.outerPosition()
          const finalSize = await currentWindow.outerSize()
          const intendedBottom = bottom
          const actualBottom = finalPos.y + finalSize.height
          // If OS honored our bottom within a few px, keep the locked value.
          if (Math.abs(actualBottom - intendedBottom) <= 4) {
            bottomEdgePhysRef.current = intendedBottom
          } else {
            // Large clamp (e.g. multi-monitor edge) — follow the OS.
            bottomEdgePhysRef.current = actualBottom
          }
        } catch {
          // keep previous lock
        }
      } catch (e) {
        console.error("Failed to resize window:", e)
      }
    }

    const runLoop = async () => {
      if (running) {
        pending = true
        return
      }
      running = true
      try {
        do {
          pending = false
          if (cancelled) return
          await applyResize()
        } while (pending && !cancelled)
      } finally {
        running = false
      }
    }

    const scheduleResize = () => {
      if (cancelled) return
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void runLoop()
      }, RESIZE_DEBOUNCE_MS)
    }

    scheduleResizeRef.current = scheduleResize
    scheduleResize()

    const observer = new ResizeObserver(() => {
      scheduleResize()
    })
    observer.observe(container)

    return () => {
      cancelled = true
      scheduleResizeRef.current = null
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      observer.disconnect()
    }
    // Intentionally empty deps: ResizeObserver covers content height changes.
    // Re-binding on activeView/displayPlugins was re-snapping the window on every
    // probe paint and looked like "乱飞" when clicking other AI providers.
  }, [])

  // After switching provider/settings, wait for React layout then resize once.
  useEffect(() => {
    if (!isTauri()) return
    let raf1 = 0
    let raf2 = 0
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        scheduleResizeRef.current?.()
      })
    })
    return () => {
      window.cancelAnimationFrame(raf1)
      window.cancelAnimationFrame(raf2)
    }
  }, [activeView])

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
