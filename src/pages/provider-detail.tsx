import { ProviderCard } from "@/components/provider-card"
import type { PluginDisplayState } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"

interface ProviderDetailPageProps {
  plugin: PluginDisplayState | null
  onRetry?: () => void
  onAccountsChanged?: () => void
  autoUpdateNextAt?: number | null
  providerWorkbench?: boolean
  onToggleProviderWorkbench?: () => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

export function ProviderDetailPage({
  plugin,
  onRetry,
  onAccountsChanged,
  autoUpdateNextAt,
  providerWorkbench,
  onToggleProviderWorkbench,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: ProviderDetailPageProps) {
  if (!plugin) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Provider not found
      </div>
    )
  }

  return (
    <ProviderCard
      providerId={plugin.meta.id}
      name={plugin.meta.name}
      plan={plugin.data?.plan}
      links={plugin.meta.links}
      showSeparator={false}
      loading={plugin.loading}
      error={plugin.error}
      lines={plugin.data?.lines ?? []}
      skeletonLines={plugin.meta.lines}
      lastManualRefreshAt={plugin.lastManualRefreshAt}
      lastUpdatedAt={plugin.lastUpdatedAt}
      onRetry={onRetry}
      onAccountsChanged={onAccountsChanged}
      autoUpdateNextAt={autoUpdateNextAt}
      providerWorkbench={providerWorkbench}
      onToggleProviderWorkbench={onToggleProviderWorkbench}
      onOpenProviderSettings={
        ["grok", "codex"].includes(plugin.meta.id)
          ? () => {
              // Lazy import store to avoid circular deps in tests
              void import("@/stores/app-ui-store").then(({ useAppUiStore }) => {
                useAppUiStore.getState().setActiveView("settings")
              })
            }
          : undefined
      }
      scopeFilter="all"
      displayMode={displayMode}
      resetTimerDisplayMode={resetTimerDisplayMode}
      timeFormatMode={timeFormatMode}
      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
    />
  )
}
