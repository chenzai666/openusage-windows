import { beforeEach, describe, expect, it } from "vitest"
import { makeCtx } from "../test-helpers.js"

const AUTH_PATH = "~/.grok/auth.json"
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
const BILLING_CREDITS_URL = BILLING_URL + "?format=credits"
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
const REFRESH_URL = "https://auth.x.ai/oauth2/token"

const loadPlugin = async () => {
  await import("./plugin.js?test=" + Math.random())
  return globalThis.__openusage_plugin
}

function writeAuth(ctx, entry) {
  const auth = {}
  auth["https://auth.x.ai::client"] = entry || {
    key: "test-token",
    email: "user@example.com",
    expires_at: "2026-06-01T00:00:00Z",
  }
  ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(auth))
}

function monthlyBillingData(overrides) {
  const config = Object.assign({
    monthlyLimit: { val: 15000 },
    used: { val: 1353 },
    onDemandCap: { val: 0 },
    billingPeriodStart: "2026-07-01T00:00:00+00:00",
    billingPeriodEnd: "2026-08-01T00:00:00+00:00",
    history: [],
  }, overrides || {})
  return { config }
}

function creditsBillingData(overrides) {
  const config = Object.assign({
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-14T02:29:27.002002+00:00",
      end: "2026-07-21T02:29:27.002002+00:00",
    },
    creditUsagePercent: 22.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: "GrokBuild", usagePercent: 22.0 },
      { product: "GrokChat" },
    ],
    isUnifiedBillingUser: true,
    billingPeriodStart: "2026-07-14T02:29:27.002002+00:00",
    billingPeriodEnd: "2026-07-21T02:29:27.002002+00:00",
  }, overrides || {})
  return { config }
}

function mockGrokApi(ctx, { monthly, credits, settings } = {}) {
  ctx.host.http.request.mockImplementation((req) => {
    const url = String(req.url || "")
    if (url === BILLING_CREDITS_URL || url.startsWith(BILLING_URL + "?format=credits")) {
      return {
        status: 200,
        bodyText: JSON.stringify(credits !== undefined ? credits : creditsBillingData()),
      }
    }
    if (url === BILLING_URL || (url.startsWith(BILLING_URL) && !url.includes("format=credits"))) {
      return {
        status: 200,
        bodyText: JSON.stringify(monthly !== undefined ? monthly : monthlyBillingData()),
      }
    }
    if (url === SETTINGS_URL) {
      return settings || {
        status: 200,
        bodyText: JSON.stringify({ subscription_tier_display: "SuperGrok" }),
      }
    }
    return { status: 404, bodyText: "" }
  })
}

describe("grok plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
  })

  it("throws when auth file is missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Grok not logged in. Run `grok login`.")
  })

  it("throws when auth file has no usable token", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ account: { email: "user@example.com" } }))
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Grok auth invalid. Run `grok login` again.")
  })

  it("throws when the only token is expired and no refresh token is available", async () => {
    const ctx = makeCtx()
    writeAuth(ctx, {
      key: "expired-token",
      email: "user@example.com",
      expires_at: "2026-01-01T00:00:00Z",
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Grok auth expired. Run `grok login` again.")
  })

  it("refreshes an expired Grok CLI token and persists rotated auth", async () => {
    const ctx = makeCtx()
    writeAuth(ctx, {
      key: "expired-token",
      refresh_token: "refresh-token",
      email: "user@example.com",
      oidc_client_id: "client-id",
      expires_at: "2026-01-01T00:00:00Z",
    })
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url === REFRESH_URL) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
        }
      }
      if (String(req.url).startsWith(BILLING_URL)) {
        return {
          status: 200,
          bodyText: JSON.stringify(
            String(req.url).includes("format=credits")
              ? creditsBillingData()
              : monthlyBillingData()
          ),
        }
      }
      if (req.url === SETTINGS_URL) {
        return {
          status: 200,
          bodyText: JSON.stringify({ subscription_tier_display: "SuperGrok" }),
        }
      }
      return { status: 404, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("SuperGrok")
    const auth = JSON.parse(ctx.host.fs.readText(AUTH_PATH))
    expect(auth["https://auth.x.ai::client"].key).toBe("new-token")
  })

  it("requests both monthly and credits billing endpoints", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const urls = ctx.host.http.request.mock.calls.map((c) => c[0].url)
    expect(urls).toContain(BILLING_CREDITS_URL)
    expect(urls).toContain(BILLING_URL)
  })

  it("renders weekly quota, products, pay-as-you-go, and monthly quota (Cliproxy Plus style)", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const labels = result.lines.map((l) => l.label)

    expect(labels).toContain("周限额")
    expect(labels).toContain("周期")
    expect(labels).toContain("GrokBuild 使用")
    expect(labels).toContain("GrokChat 使用")
    expect(labels).toContain("按量付费")
    expect(labels).toContain("月度额度")
    expect(labels).toContain("月度用量")

    const weekly = result.lines.find((l) => l.label === "周限额")
    expect(weekly.type).toBe("progress")
    expect(weekly.used).toBe(22)
    expect(weekly.limit).toBe(100)
    expect(weekly.resetsAt).toBe("2026-07-21T02:29:27.002Z")
    expect(weekly.periodDurationMs).toBe(7 * 24 * 60 * 60 * 1000)

    const build = result.lines.find((l) => l.label === "GrokBuild 使用")
    expect(build.used).toBe(22)

    const chat = result.lines.find((l) => l.label === "GrokChat 使用")
    expect(chat.type).toBe("text")
    expect(chat.value).toBe("已用 --")

    const payg = result.lines.find((l) => l.label === "按量付费")
    expect(payg.text).toBe("未启用")

    const monthly = result.lines.find((l) => l.label === "月度额度")
    expect(monthly.type).toBe("progress")
    expect(monthly.format).toEqual({ kind: "dollars" })
    expect(monthly.used).toBeCloseTo(13.53, 2)
    expect(monthly.limit).toBeCloseTo(150, 2)
    expect(monthly.resetsAt).toBe("2026-08-01T00:00:00.000Z")

    const monthlyDetail = result.lines.find((l) => l.label === "月度用量")
    expect(monthlyDetail.value).toContain("$13.53")
    expect(monthlyDetail.value).toContain("$150.00")
  })

  it("renders pay as you go cap when enabled", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx, {
      credits: creditsBillingData({ onDemandCap: { val: 2500 } }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const line = result.lines.find((l) => l.label === "按量付费")

    expect(line.text).toBe("上限 2500")
    expect(line.color).toBe("#22c55e")
  })

  it("still works when credits endpoint fails but monthly succeeds", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      const url = String(req.url || "")
      if (url.includes("format=credits")) {
        return { status: 500, bodyText: "nope" }
      }
      if (url === BILLING_URL) {
        return { status: 200, bodyText: JSON.stringify(monthlyBillingData()) }
      }
      if (url === SETTINGS_URL) {
        return {
          status: 200,
          bodyText: JSON.stringify({ subscription_tier_display: "SuperGrok" }),
        }
      }
      return { status: 404, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "月度额度")).toBeTruthy()
    expect(result.lines.find((l) => l.label === "周限额")).toBeUndefined()
  })

  it("throws when billing request returns auth error", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    ctx.host.http.request.mockImplementation(() => ({ status: 401, bodyText: "" }))
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Grok auth expired. Run `grok login` again.")
  })

  it("throws on billing network error when both endpoints fail", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("network")
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Grok billing request failed. Check your connection.")
  })

  it("reads the plan name from settings", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx, {
      settings: {
        status: 200,
        bodyText: JSON.stringify({ subscription_tier_display: "SuperGrok Heavy" }),
      },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBe("SuperGrok Heavy")
  })

  it("parses monthly units provided as strings", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx, {
      monthly: monthlyBillingData({
        monthlyLimit: { val: "10000" },
        used: { val: "2500" },
      }),
      credits: creditsBillingData({ creditUsagePercent: 10 }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const monthly = result.lines.find((l) => l.label === "月度额度")
    expect(monthly.used).toBeCloseTo(25, 2)
    expect(monthly.limit).toBeCloseTo(100, 2)
  })
})
