import { create } from "zustand"
import type { ActiveView } from "@/components/side-nav"

type AppUiStore = {
  activeView: ActiveView
  showAbout: boolean
  /** Grok multi-column workbench (design doc fullscreen-ish panel). */
  grokWorkbench: boolean
  setActiveView: (view: ActiveView) => void
  setShowAbout: (value: boolean) => void
  setGrokWorkbench: (value: boolean) => void
  toggleGrokWorkbench: () => void
  resetState: () => void
}

const initialState = {
  activeView: "home" as ActiveView,
  showAbout: false,
  grokWorkbench: false,
}

export const useAppUiStore = create<AppUiStore>((set) => ({
  ...initialState,
  setActiveView: (view) =>
    set((s) => ({
      activeView: view,
      // Leave workbench when navigating away from home overview.
      grokWorkbench: view === "home" ? s.grokWorkbench : false,
    })),
  setShowAbout: (value) => set({ showAbout: value }),
  setGrokWorkbench: (value) => set({ grokWorkbench: value }),
  toggleGrokWorkbench: () => set((s) => ({ grokWorkbench: !s.grokWorkbench })),
  resetState: () => set(initialState),
}))
