import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const account = (key, token) => ({
  entryKey: key,
  emailMasked: `${key}***@example.com`,
  auth: { tokens: { access_token: token, account_id: key } }
})
const resultPayload = (result) =>
  JSON.parse(result.lines.find((l) => l.label === "__chatgpt_v1").value)
const load = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

describe("CLIProxy Codex imports", () => {
  beforeEach(() => {
    vi.resetModules()
    delete globalThis.__openusage_plugin
  })

  it("queries imported accounts independently and uses only selected account for tray", async () => {
    const ctx = makeCtx()
    ctx.host.codexAccounts = {
      load: () =>
        JSON.stringify({
          accounts: [account("a", "private-a"), account("b", "private-b")],
          trayEntryKey: "b"
        })
    }
    ctx.host.http.request.mockImplementation((req) => {
      expect(req.url).toBe("https://chatgpt.com/backend-api/wham/usage")
      const used = req.headers["ChatGPT-Account-Id"] === "a" ? 10 : 60
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: used } }
        })
      }
    })
    const result = (await load()).probe(ctx)
    expect(resultPayload(result).accounts).toHaveLength(2)
    expect(result.lines.find((l) => l.label === "Session").used).toBe(60)
    expect(JSON.stringify(result)).not.toContain("private-")
    expect(JSON.stringify(result)).not.toContain("access_token")
    expect(ctx.host.ccusage.query).not.toHaveBeenCalled()
    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
  })

  it("preserves healthy cards when one import expires and does not refresh CLIProxy tokens", async () => {
    const ctx = makeCtx()
    ctx.host.codexAccounts = {
      load: () =>
        JSON.stringify({
          accounts: [account("bad", "old"), account("ok", "good")],
          trayEntryKey: "bad"
        })
    }
    ctx.host.http.request.mockImplementation((req) => ({
      status: req.headers.Authorization === "Bearer old" ? 401 : 200,
      headers: {},
      bodyText: JSON.stringify({ rate_limit: { secondary_window: { used_percent: 25 } } })
    }))
    const result = (await load()).probe(ctx)
    const cards = resultPayload(result).accounts
    expect(cards[0].error).toContain("重新导入")
    expect(cards[1].lines.find((l) => l.label === "Weekly").used).toBe(25)
    expect(cards[1].error).toBeNull()
    expect(ctx.host.http.request.mock.calls.every(([req]) => !req.url.includes("oauth"))).toBe(true)
    expect(result.lines.filter((l) => l.type === "progress")).toEqual([])
  })

  it("keeps local auth and local usage separate from imported cards", async () => {
    const ctx = makeCtx()
    const localJson = JSON.stringify({ tokens: { access_token: "local-private" } })
    ctx.host.fs.writeText("~/.codex/auth.json", localJson)
    ctx.host.codexAccounts = {
      load: () =>
        JSON.stringify({ accounts: [account("a", "imported-private")], trayEntryKey: "local" })
    }
    ctx.host.http.request.mockReturnValue({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ rate_limit: { primary_window: { used_percent: 7 } } })
    })
    const result = (await load()).probe(ctx)
    expect(resultPayload(result).accounts.map((a) => a.entryKey)).toEqual(["local", "a"])
    expect(ctx.host.fs.readText("~/.codex/auth.json")).toBe(localJson)
    expect(resultPayload(result).trayEntryKey).toBe("local")
  })

  it("falls back to native auth unchanged when there are no imports", async () => {
    const ctx = makeCtx()
    ctx.host.codexAccounts = { load: () => JSON.stringify({ accounts: [] }) }
    const plugin = await load()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("clears removed imported cards even when no local login exists", async () => {
    const ctx = makeCtx()
    ctx.host.codexAccounts = { load: () => JSON.stringify({ accounts: [], configured: true }) }
    const result = (await load()).probe(ctx)
    expect(resultPayload(result).accounts).toEqual([])
  })

  it("does not resurrect removed imports when the local login is expired", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(
      "~/.codex/auth.json",
      JSON.stringify({ tokens: { access_token: "expired" } })
    )
    ctx.host.codexAccounts = { load: () => JSON.stringify({ accounts: [], configured: true }) }
    ctx.host.http.request.mockReturnValue({ status: 401, headers: {}, bodyText: "" })
    const cards = resultPayload((await load()).probe(ctx)).accounts
    expect(cards).toHaveLength(1)
    expect(cards[0].entryKey).toBe("local")
    expect(cards[0].error).toBeTruthy()
  })
})
