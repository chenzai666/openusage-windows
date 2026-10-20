import { create } from "zustand"
import type { ActiveView } from "@/components/side-nav"

type AppUiStore = {
  activeView: ActiveView
  showAbout: boolean
  /** Shared Grok / ChatGPT multi-column workbench. */
  providerWorkbench: boolean
  setActiveView: (view: ActiveView) => void
  setShowAbout: (value: boolean) => void
  setProviderWorkbench: (value: boolean) => void
  toggleProviderWorkbench: () => void
  resetState: () => void
}

const initialState = {
  activeView: "home" as ActiveView,
  showAbout: false,
  providerWorkbench: false,
}

export const useAppUiStore = create<AppUiStore>((set) => ({
  ...initialState,
  setActiveView: (view) =>
    set((s) => ({
      activeView: view,
      providerWorkbench: view === s.activeView ? s.providerWorkbench : false,
    })),
  setShowAbout: (value) => set({ showAbout: value }),
  setProviderWorkbench: (value) => set({ providerWorkbench: value }),
  toggleProviderWorkbench: () => set((s) => ({ providerWorkbench: !s.providerWorkbench })),
  resetState: () => set(initialState),
}))
