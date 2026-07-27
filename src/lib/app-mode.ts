import type { PluginSettings } from "@/lib/settings"

export const GROK_PLUGIN_ID = "grok"

/**
 * Build-time flavor: `VITE_GROK_ONLY=true` ships as Grok-only product.
 * Runtime preference can also enable this via settings store.
 */
export function isGrokOnlyEnv(): boolean {
  try {
    const v = import.meta.env.VITE_GROK_ONLY
    return v === "true" || v === "1"
  } catch {
    return false
  }
}

/** Force plugin settings so only Grok is enabled (others disabled, Grok first). */
export function applyGrokOnlyPluginSettings(
  settings: PluginSettings,
  knownIds: string[]
): PluginSettings {
  const knownSet = new Set(knownIds)
  const rest = (settings.order.length ? settings.order : knownIds).filter(
    (id) => id !== GROK_PLUGIN_ID && knownSet.has(id)
  )
  const order = [
    ...(knownSet.has(GROK_PLUGIN_ID) ? [GROK_PLUGIN_ID] : []),
    ...rest,
    ...knownIds.filter((id) => id !== GROK_PLUGIN_ID && !rest.includes(id)),
  ]
  const disabled = knownIds.filter((id) => id !== GROK_PLUGIN_ID)
  return {
    order: Array.from(new Set(order)),
    disabled: Array.from(new Set(disabled)),
  }
}

export function productDisplayName(grokOnly: boolean): string {
  return grokOnly ? "OpenUsage Grok" : "OpenUsage"
}
