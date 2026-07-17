import { beforeEach, describe, expect, it } from "vitest"
import { makeCtx } from "../test-helpers.js"

const AUTH_PATH = "~/.grok/auth.json"
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
const BILLING_CREDITS_URL = BILLING_URL + "?format=credits"
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
const CHAT_URL = "https://cli-chat-proxy.grok.com/v1/chat/completions"
const REFRESH_URL = "https://auth.x.ai/oauth2/token"

const loadPlugin = async () => {
  await import("./plugin.js?test=" + Math.random())
  return globalThis.__openusage_plugin
}

function writeAuth(ctx, entries) {
  if (entries) {
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(entries))
    return
  }
  const auth = {}
  auth["https://auth.x.ai::client"] = {
    key: "test-token",
    email: "user@example.com",
    expires_at: "2026-06-01T00:00:00Z",
  }
  ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(auth))
}

function monthlyBillingData(overrides) {
  const config = Object.assign(
    {
      monthlyLimit: { val: 15000 },
      used: { val: 1353 },
      onDemandCap: { val: 0 },
      billingPeriodStart: "2026-07-01T00:00:00+00:00",
      billingPeriodEnd: "2026-08-01T00:00:00+00:00",
      history: [],
    },
    overrides || {}
  )
  return { config }
}

function creditsBillingData(overrides) {
  const config = Object.assign(
    {
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
    },
    overrides || {}
  )
  return { config }
}

function mockGrokApi(ctx, { monthly, credits, settings, chatStatus } = {}) {
  ctx.host.http.request.mockImplementation((req) => {
    const url = String(req.url || "")
    if (url === CHAT_URL || url.includes("/v1/chat/completions")) {
      return { status: chatStatus !== undefined ? chatStatus : 200, bodyText: "{}" }
    }
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
      return (
        settings || {
          status: 200,
          bodyText: JSON.stringify({ subscription_tier_display: "SuperGrok" }),
        }
      )
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

  it("shows re-login status when the only token is expired without refresh", async () => {
    const ctx = makeCtx()
    writeAuth(ctx, {
      "https://auth.x.ai::client": {
        key: "expired-token",
        email: "user@example.com",
        expires_at: "2026-01-01T00:00:00Z",
      },
    })
    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const status = result.lines.find((l) => l.label === "状态")
    expect(status.text).toBe("需重新登录")
  })

  it("parses Play renewal paste into dd/mm/YYYY · method", async () => {
    const plugin = await loadPlugin()
    const parsed = plugin.__test.parseRenewalPaste(
      "Renews on July 18, 2026 · billed via Google Play"
    )
    expect(parsed).toEqual({ date: "18/07/2026", method: "Google Play" })
  })

  it("masks emails for display", async () => {
    const plugin = await loadPlugin()
    expect(plugin.__test.maskEmail("chenzai666@gmail.com")).toBe("che***66@gmail.com")
  })

  it("formats JWT tier as 层级 badge", async () => {
    const plugin = await loadPlugin()
    const t1 = plugin.__test.formatTierBadge(1)
    expect(t1.text).toBe("层级 1")
    expect(t1.note).toContain("gate")
    expect(plugin.__test.formatPlanWithTier("SuperGrok", 1)).toBe("层级 1 · SuperGrok")
  })

  it("shows 层级 in plan and card when access token JWT contains tier", async () => {
    const ctx = makeCtx()
    // Minimal JWT: header.payload.sig — decodePayload only needs middle part
    const payloadB64 = Buffer.from(
      JSON.stringify({ tier: 1, exp: 9999999999, email: "t@example.com" })
    ).toString("base64url")
    const token = "eyJhbGciOiJub25lIn0." + payloadB64 + ".sig"
    writeAuth(ctx, {
      "https://auth.x.ai::client": {
        key: token,
        email: "tieruser@example.com",
        expires_at: "2026-12-01T00:00:00Z",
      },
    })
    mockGrokApi(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toContain("层级 1")
    expect(result.plan).toContain("SuperGrok")
    const raw = result.lines.find((l) => l.label === "__grok_v1")
    const data = JSON.parse(raw.value)
    expect(data.accounts[0].tier).toBe(1)
    expect(data.accounts[0].planLine).toContain("层级 1")
  })

  it("sends Grok CLI aligned headers on billing requests", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const billingCall = ctx.host.http.request.mock.calls.find((c) =>
      String(c[0].url).includes("/v1/billing")
    )
    expect(billingCall).toBeTruthy()
    const headers = billingCall[0].headers
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli")
    expect(headers["X-Grok-Client-Identifier"]).toBe("grok-shell")
    expect(headers["User-Agent"]).toBe("Grok CLI/0.2.93")
  })

  it("runs billing + settings + chat probe and emits design-doc card payload", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx, { chatStatus: 200 })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const labels = result.lines.map((l) => l.label)

    // Structured payload for screenshot cards
    expect(labels).toContain("__grok_v1")
    const raw = result.lines.find((l) => l.label === "__grok_v1")
    const payload = JSON.parse(raw.value)
    expect(payload.v).toBe(1)
    expect(payload.accounts).toHaveLength(1)
    const card = payload.accounts[0]
    expect(card.emailMasked).toContain("@example.com")
    expect(card.weeklyPercent).toBe(22)
    expect(card.buildPercent).toBe(22)
    expect(card.apiUsed).toBe(1353)
    expect(card.apiLimit).toBe(15000)
    expect(card.probe.ok).toBe(3)
    expect(card.probe.fail).toBe(0)
    expect(card.probe.chat.ok).toBe(true)
    expect(card.status).toBe("正常")
    expect(card.payAsYouGo).toBe("未启用")

    // Tray weekly candidate still present
    const weekly = result.lines.find((l) => l.label === "周限额" && l.type === "progress")
    expect(weekly.used).toBe(22)

    expect(result.plan).toBeTruthy()

    const urls = ctx.host.http.request.mock.calls.map((c) => c[0].url)
    expect(urls.some((u) => String(u).includes("/chat/completions"))).toBe(true)
  })

  it("shows chat gate hint when chat returns 403", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx, { chatStatus: 403 })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const raw = result.lines.find((l) => l.label === "__grok_v1")
    const payload = JSON.parse(raw.value)
    expect(payload.accounts[0].probe.fail).toBe(1)
    expect(payload.accounts[0].probe.note).toContain("403")
  })

  it("probes multiple accounts into design payload cards", async () => {
    const ctx = makeCtx()
    writeAuth(ctx, {
      "https://auth.x.ai::a": {
        key: "token-a",
        email: "alice@example.com",
        expires_at: "2026-12-01T00:00:00Z",
      },
      "https://auth.x.ai::b": {
        key: "token-b",
        email: "bob@example.com",
        expires_at: "2026-12-01T00:00:00Z",
      },
    })
    mockGrokApi(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const raw = result.lines.find((l) => l.label === "__grok_v1")
    const payload = JSON.parse(raw.value)
    expect(payload.accounts).toHaveLength(2)
    expect(result.plan).toContain("2 账号")
  })

  it("shows subscription renew from meta paste", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    // pluginDataDir from makeCtx
    const metaPath = ctx.app.pluginDataDir + "/accounts-meta.json"
    ctx.host.fs.writeText(
      metaPath,
      JSON.stringify({
        entries: {
          "https://auth.x.ai::client": {
            labels: ["周02"],
            subscription_paste: "Renews on July 18, 2026 · billed via Google Play",
          },
        },
      })
    )
    mockGrokApi(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const account = result.lines.find((l) => l.label === "账号")
    expect(account.value).toContain("周02")
    const sub = result.lines.find((l) => l.label === "订阅续费")
    expect(sub.value).toBe("18/07/2026 · Google Play")
  })

  it("still works when credits fails but monthly succeeds", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      const url = String(req.url || "")
      if (url.includes("format=credits")) return { status: 500, bodyText: "nope" }
      if (url === BILLING_URL) {
        return { status: 200, bodyText: JSON.stringify(monthlyBillingData()) }
      }
      if (url === SETTINGS_URL) {
        return {
          status: 200,
          bodyText: JSON.stringify({ subscription_tier_display: "SuperGrok" }),
        }
      }
      if (url.includes("/chat/")) return { status: 200, bodyText: "{}" }
      return { status: 404, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "API 月额度")).toBeTruthy()
  })

  it("shows Build missing hint when productUsage has no GrokBuild percent", async () => {
    const ctx = makeCtx()
    writeAuth(ctx)
    mockGrokApi(ctx, {
      credits: creditsBillingData({
        productUsage: [{ product: "GrokChat" }],
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const build = result.lines.find((l) => l.label === "Build 用量")
    expect(build.type).toBe("text")
    expect(build.value).toContain("接口未返回 Build 字段")
  })

  it("refreshes an expired Grok CLI token and persists rotated auth", async () => {
    const ctx = makeCtx()
    writeAuth(ctx, {
      "https://auth.x.ai::client": {
        key: "expired-token",
        refresh_token: "refresh-token",
        email: "user@example.com",
        oidc_client_id: "client-id",
        expires_at: "2026-01-01T00:00:00Z",
      },
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
      if (String(req.url).includes("/chat/")) return { status: 200, bodyText: "{}" }
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
    expect(result.plan).toContain("SuperGrok")
    const auth = JSON.parse(ctx.host.fs.readText(AUTH_PATH))
    expect(auth["https://auth.x.ai::client"].key).toBe("new-token")
  })
})
