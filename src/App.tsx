import { useCallback, useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { AppShell } from "@/components/app/app-shell"
import { useAppPluginViews } from "@/hooks/app/use-app-plugin-views"
import { useProbe } from "@/hooks/app/use-probe"
import { useSettingsBootstrap } from "@/hooks/app/use-settings-bootstrap"
import { useSettingsDisplayActions } from "@/hooks/app/use-settings-display-actions"
import { useSettingsPluginActions } from "@/hooks/app/use-settings-plugin-actions"
import { useSettingsPluginList } from "@/hooks/app/use-settings-plugin-list"
import { useSettingsSystemActions } from "@/hooks/app/use-settings-system-actions"
import { useSettingsTheme } from "@/hooks/app/use-settings-theme"
import { useTrayIcon } from "@/hooks/app/use-tray-icon"
import { applyGrokOnlyPluginSettings } from "@/lib/app-mode"
import {
  REFRESH_COOLDOWN_MS,
  normalizePluginSettings,
  saveGrokOnlyMode,
  savePluginSettings,
} from "@/lib/settings"
import { type PluginContextAction } from "@/components/side-nav"
import { useAppPluginStore } from "@/stores/app-plugin-store"
import { useAppPreferencesStore } from "@/stores/app-preferences-store"
import { useAppUiStore } from "@/stores/app-ui-store"

const TRAY_PROBE_DEBOUNCE_MS = 500
const TRAY_SETTINGS_DEBOUNCE_MS = 2000

function App() {
  const {
    activeView,
    setActiveView,
  } = useAppUiStore(
    useShallow((state) => ({
      activeView: state.activeView,
      setActiveView: state.setActiveView,
    }))
  )

  const {
    pluginsMeta,
    setPluginsMeta,
    pluginSettings,
    setPluginSettings,
  } = useAppPluginStore(
    useShallow((state) => ({
      pluginsMeta: state.pluginsMeta,
      setPluginsMeta: state.setPluginsMeta,
      pluginSettings: state.pluginSettings,
      setPluginSettings: state.setPluginSettings,
    }))
  )

  const {
    autoUpdateInterval,
    setAutoUpdateInterval,
    themeMode,
    setThemeMode,
    displayMode,
    setDisplayMode,
    menubarIconStyle,
    setMenubarIconStyle,
    menubarMetric,
    setMenubarMetric,
    resetTimerDisplayMode,
    setResetTimerDisplayMode,
    setTimeFormatMode,
    setGlobalShortcut,
    setStartOnLogin,
    grokOnlyMode,
    setGrokOnlyMode,
  } = useAppPreferencesStore(
    useShallow((state) => ({
      autoUpdateInterval: state.autoUpdateInterval,
      setAutoUpdateInterval: state.setAutoUpdateInterval,
      themeMode: state.themeMode,
      setThemeMode: state.setThemeMode,
      displayMode: state.displayMode,
      setDisplayMode: state.setDisplayMode,
      menubarIconStyle: state.menubarIconStyle,
      setMenubarIconStyle: state.setMenubarIconStyle,
      menubarMetric: state.menubarMetric,
      setMenubarMetric: state.setMenubarMetric,
      resetTimerDisplayMode: state.resetTimerDisplayMode,
      setResetTimerDisplayMode: state.setResetTimerDisplayMode,
      setTimeFormatMode: state.setTimeFormatMode,
      setGlobalShortcut: state.setGlobalShortcut,
      setStartOnLogin: state.setStartOnLogin,
      grokOnlyMode: state.grokOnlyMode,
      setGrokOnlyMode: state.setGrokOnlyMode,
    }))
  )

  const scheduleProbeTrayUpdateRef = useRef<() => void>(() => {})
  const handleProbeResult = useCallback(() => {
    scheduleProbeTrayUpdateRef.current()
  }, [])

  const {
    pluginStates,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    autoUpdateNextAt,
    setAutoUpdateNextAt,
    handleRetryPlugin,
    handleRefreshAll,
  } = useProbe({
    pluginSettings,
    autoUpdateInterval,
    onProbeResult: handleProbeResult,
  })

  const pendingCodexImportRef = useRef(false)
  const handleCodexAccountsChanged = useCallback(() => {
    if (pluginStates.codex?.loading) {
      pendingCodexImportRef.current = true
    } else {
      handleRetryPlugin("codex", true)
    }
  }, [pluginStates.codex?.loading, handleRetryPlugin])

  useEffect(() => {
    if (pendingCodexImportRef.current && !pluginStates.codex?.loading) {
      pendingCodexImportRef.current = false
      handleRetryPlugin("codex", true)
    }
  }, [pluginStates.codex?.loading, handleRetryPlugin])

  const { scheduleTrayIconUpdate, traySettingsPreview } = useTrayIcon({
    pluginsMeta,
    pluginSettings,
    pluginStates,
    displayMode,
    menubarIconStyle,
    menubarMetric,
    activeView,
  })

  useEffect(() => {
    scheduleProbeTrayUpdateRef.current = () => {
      scheduleTrayIconUpdate("probe", TRAY_PROBE_DEBOUNCE_MS)
    }
  }, [scheduleTrayIconUpdate])

  const { applyStartOnLogin } = useSettingsBootstrap({
    setPluginSettings,
    setPluginsMeta,
    setAutoUpdateInterval,
    setThemeMode,
    setDisplayMode,
    setMenubarIconStyle,
    setMenubarMetric,
    setGrokOnlyMode,
    setResetTimerDisplayMode,
    setTimeFormatMode,
    setGlobalShortcut,
    setStartOnLogin,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
  })

  useSettingsTheme(themeMode)

  const {
    handleThemeModeChange,
    handleDisplayModeChange,
    handleResetTimerDisplayModeChange,
    handleResetTimerDisplayModeToggle,
    handleTimeFormatModeChange,
    handleMenubarIconStyleChange,
    handleMenubarMetricChange,
  } = useSettingsDisplayActions({
    setThemeMode,
    setDisplayMode,
    resetTimerDisplayMode,
    setResetTimerDisplayMode,
    setTimeFormatMode,
    setMenubarIconStyle,
    setMenubarMetric,
    scheduleTrayIconUpdate,
  })

  const {
    handleAutoUpdateIntervalChange,
    handleGlobalShortcutChange,
    handleStartOnLoginChange,
  } = useSettingsSystemActions({
    pluginSettings,
    setAutoUpdateInterval,
    setAutoUpdateNextAt,
    setGlobalShortcut,
    setStartOnLogin,
    applyStartOnLogin,
  })

  const {
    handleReorder,
    handleToggle,
  } = useSettingsPluginActions({
    pluginSettings,
    setPluginSettings,
    setLoadingForPlugins,
    setErrorForPlugins,
    startBatch,
    scheduleTrayIconUpdate,
  })

  const settingsPlugins = useSettingsPluginList({
    pluginSettings,
    pluginsMeta,
  })

  const { displayPlugins, navPlugins, selectedPlugin } = useAppPluginViews({
    activeView,
    setActiveView,
    pluginSettings,
    pluginsMeta,
    pluginStates,
  })

  const pluginSettingsRef = useRef(pluginSettings)
  useEffect(() => {
    pluginSettingsRef.current = pluginSettings
  }, [pluginSettings])

  const handlePluginContextAction = useCallback(
    (pluginId: string, action: PluginContextAction) => {
      if (action === "reload") {
        handleRetryPlugin(pluginId)
        return
      }

      const currentSettings = pluginSettingsRef.current
      if (!currentSettings) return
      const alreadyDisabled = currentSettings.disabled.includes(pluginId)
      if (alreadyDisabled) return

      const nextSettings = {
        ...currentSettings,
        disabled: [...currentSettings.disabled, pluginId],
      }
      setPluginSettings(nextSettings)
      scheduleTrayIconUpdate("settings", TRAY_SETTINGS_DEBOUNCE_MS)
      void savePluginSettings(nextSettings).catch((error) => {
        console.error("Failed to save plugin toggle:", error)
      })

      if (activeView === pluginId) {
        setActiveView("home")
      }
    },
    [activeView, handleRetryPlugin, scheduleTrayIconUpdate, setActiveView, setPluginSettings]
  )

  const isPluginRefreshAvailable = useCallback(
    (pluginId: string) => {
      const pluginState = pluginStates[pluginId]
      if (!pluginState) return true
      if (pluginState.loading) return false
      if (!pluginState.lastManualRefreshAt) return true
      return Date.now() - pluginState.lastManualRefreshAt >= REFRESH_COOLDOWN_MS
    },
    [pluginStates]
  )

  const handleGrokOnlyModeChange = useCallback(
    async (enabled: boolean) => {
      setGrokOnlyMode(enabled)
      try {
        await saveGrokOnlyMode(enabled)
      } catch (e) {
        console.error("Failed to save grok-only mode:", e)
      }
      if (!pluginSettings || pluginsMeta.length === 0) return
      const knownIds = pluginsMeta.map((p) => p.id)
      const next = enabled
        ? applyGrokOnlyPluginSettings(pluginSettings, knownIds)
        : normalizePluginSettings(pluginSettings, pluginsMeta, { grokOnly: false })
      // When turning off, re-enable default set for newly free plugins still disabled
      setPluginSettings(next)
      try {
        await savePluginSettings(next)
      } catch (e) {
        console.error("Failed to save plugins after grok-only toggle:", e)
      }
      scheduleTrayIconUpdate("settings", 0)
      if (enabled) {
        setActiveView("home")
        void handleRetryPlugin("grok")
      }
    },
    [
      handleRetryPlugin,
      pluginSettings,
      pluginsMeta,
      scheduleTrayIconUpdate,
      setActiveView,
      setGrokOnlyMode,
      setPluginSettings,
    ]
  )

  // Nav: in Grok-only mode only surface Grok (plus home/settings chrome)
  const navPluginsGrok = grokOnlyMode
    ? navPlugins.filter((p) => p.id === "grok")
    : navPlugins
  const displayPluginsGrok = grokOnlyMode
    ? displayPlugins.filter((p) => p.meta.id === "grok")
    : displayPlugins

  return (
    <AppShell
      onRefreshAll={handleRefreshAll}
      navPlugins={navPluginsGrok}
      displayPlugins={displayPluginsGrok}
      settingsPlugins={settingsPlugins}
      autoUpdateNextAt={autoUpdateNextAt}
      selectedPlugin={selectedPlugin}
      onPluginContextAction={handlePluginContextAction}
      isPluginRefreshAvailable={isPluginRefreshAvailable}
      onNavReorder={handleReorder}
      appContentProps={{
        onRetryPlugin: handleRetryPlugin,
        onReorder: handleReorder,
        onToggle: handleToggle,
        onAutoUpdateIntervalChange: handleAutoUpdateIntervalChange,
        onThemeModeChange: handleThemeModeChange,
        onDisplayModeChange: handleDisplayModeChange,
        onResetTimerDisplayModeChange: handleResetTimerDisplayModeChange,
        onResetTimerDisplayModeToggle: handleResetTimerDisplayModeToggle,
        onTimeFormatModeChange: handleTimeFormatModeChange,
        onMenubarIconStyleChange: handleMenubarIconStyleChange,
        onMenubarMetricChange: handleMenubarMetricChange,
        traySettingsPreview,
        onGlobalShortcutChange: handleGlobalShortcutChange,
        onStartOnLoginChange: handleStartOnLoginChange,
        onGrokOnlyModeChange: handleGrokOnlyModeChange,
        onGrokAccountsChanged: () => handleRetryPlugin("grok"),
        onCodexAccountsChanged: handleCodexAccountsChanged,
        autoUpdateNextAt,
      }}
    />
  )
}

export { App }
