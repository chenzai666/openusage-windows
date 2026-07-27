import { describe, expect, it } from "vitest"
import { applyGrokOnlyPluginSettings, productDisplayName } from "@/lib/app-mode"

describe("applyGrokOnlyPluginSettings", () => {
  it("enables only grok and puts it first", () => {
    const next = applyGrokOnlyPluginSettings(
      { order: ["cursor", "claude", "grok"], disabled: [] },
      ["claude", "codex", "cursor", "grok"]
    )
    expect(next.order[0]).toBe("grok")
    expect(next.disabled).toEqual(["claude", "codex", "cursor"])
    expect(next.disabled).not.toContain("grok")
  })
})

describe("productDisplayName", () => {
  it("labels grok-only product", () => {
    expect(productDisplayName(true)).toBe("OpenUsage Grok")
    expect(productDisplayName(false)).toBe("OpenUsage")
  })
})
