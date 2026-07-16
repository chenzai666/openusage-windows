(function () {
  const AUTH_PATH = "~/.grok/auth.json"
  const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
  const BILLING_CREDITS_URL = BILLING_URL + "?format=credits"
  const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
  const REFRESH_URL = "https://auth.x.ai/oauth2/token"
  const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
  const TOKEN_AUTH_HEADER = "xai-grok-cli"
  const AUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000
  const LOGIN_HINT = "Grok auth expired. Run `grok login` again."

  // Grok CLI billing units are reported in cents ($1.00 = 100).
  const CENTS_PER_DOLLAR = 100

  const PRODUCT_LABELS = {
    GrokBuild: "GrokBuild 使用",
    GrokChat: "GrokChat 使用",
    GrokImagine: "GrokImagine 使用",
    GrokVoice: "GrokVoice 使用",
  }

  function readJson(ctx, path) {
    if (!ctx.host.fs.exists(path)) return null
    try {
      return ctx.util.tryParseJson(ctx.host.fs.readText(path))
    } catch {
      return null
    }
  }

  function entryExpiresAtMs(ctx, entry) {
    if (!entry || typeof entry !== "object") return null
    if (entry.expires_at) return ctx.util.parseDateMs(entry.expires_at)
    if (entry.expires) return ctx.util.parseDateMs(entry.expires)
    return null
  }

  function tokenExpiresAtMs(ctx, token) {
    const payload = ctx.jwt.decodePayload(token)
    if (!payload || typeof payload.exp !== "number") return null
    return payload.exp * 1000
  }

  function needsRefresh(ctx, entry, token, nowMs) {
    const entryMs = entryExpiresAtMs(ctx, entry)
    const tokenMs = tokenExpiresAtMs(ctx, token)
    const entryNeedsRefresh = entryMs !== null && ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: entryMs,
      bufferMs: AUTH_REFRESH_BUFFER_MS,
    })
    const tokenNeedsRefresh = tokenMs !== null && ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: tokenMs,
      bufferMs: AUTH_REFRESH_BUFFER_MS,
    })
    return entryNeedsRefresh || tokenNeedsRefresh
  }

  function isExpired(ctx, entry, token, nowMs) {
    const entryMs = entryExpiresAtMs(ctx, entry)
    const tokenMs = tokenExpiresAtMs(ctx, token)
    const expiresAtMs = tokenMs !== null ? tokenMs : entryMs
    if (expiresAtMs === null) return false
    return nowMs >= expiresAtMs
  }

  function readRefreshToken(entry) {
    if (!entry || typeof entry !== "object") return ""
    const refreshToken = typeof entry.refresh_token === "string" ? entry.refresh_token.trim() : ""
    if (refreshToken) return refreshToken
    return typeof entry.refresh === "string" ? entry.refresh.trim() : ""
  }

  function readClientId(entryKey, entry) {
    if (entry && typeof entry.oidc_client_id === "string" && entry.oidc_client_id.trim()) {
      return entry.oidc_client_id.trim()
    }
    const parts = String(entryKey || "").split("::")
    const fromKey = parts.length > 1 ? parts[parts.length - 1].trim() : ""
    return fromKey || DEFAULT_CLIENT_ID
  }

  function nowMs(ctx) {
    return ctx.util.parseDateMs(ctx.nowIso) || Date.now()
  }

  function refreshAuth(ctx, auth, entryKey, entry) {
    const refreshToken = readRefreshToken(entry)
    if (!refreshToken) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting Grok auth refresh")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" + encodeURIComponent(readClientId(entryKey, entry)) +
          "&refresh_token=" + encodeURIComponent(refreshToken),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        const body = ctx.util.tryParseJson(resp.bodyText)
        const code = body && ((body.error && body.error.code) || body.error || body.code)
        ctx.host.log.error("Grok auth refresh failed: status=" + resp.status + " code=" + String(code))
        return null
      }
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("Grok auth refresh returned status: " + resp.status)
        return null
      }

      const body = ctx.util.tryParseJson(resp.bodyText)
      if (!body || typeof body.access_token !== "string" || !body.access_token.trim()) {
        ctx.host.log.warn("Grok auth refresh response missing access_token")
        return null
      }

      const accessToken = body.access_token.trim()
      entry.key = accessToken
      if (typeof body.refresh_token === "string" && body.refresh_token.trim()) {
        entry.refresh_token = body.refresh_token.trim()
      }
      if (typeof body.id_token === "string" && body.id_token.trim()) {
        entry.id_token = body.id_token.trim()
      }

      const refreshedAtMs = nowMs(ctx)
      const expiresIn = Number(body.expires_in)
      const tokenExpiryMs = tokenExpiresAtMs(ctx, accessToken)
      const expiresAtMs = Number.isFinite(expiresIn) && expiresIn > 0
        ? refreshedAtMs + expiresIn * 1000
        : tokenExpiryMs || refreshedAtMs + 3600 * 1000
      entry.expires_at = new Date(expiresAtMs).toISOString()

      try {
        ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(auth, null, 2))
        ctx.host.log.info("Grok auth refresh succeeded, token persisted")
      } catch (e) {
        ctx.host.log.warn("Grok auth refresh succeeded but failed to save auth: " + String(e))
      }

      return accessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("Grok auth refresh exception: " + String(e))
      return null
    }
  }

  function loadAuth(ctx) {
    const auth = readJson(ctx, AUTH_PATH)
    if (!auth || typeof auth !== "object") {
      throw "Grok not logged in. Run `grok login`."
    }

    const currentMs = nowMs(ctx)
    let expiredCandidate = false
    const keys = Object.keys(auth)
    for (let i = 0; i < keys.length; i++) {
      const entryKey = keys[i]
      const entry = auth[entryKey]
      if (!entry || typeof entry !== "object") continue
      const token = typeof entry.key === "string" ? entry.key.trim() : ""
      if (!token) continue
      if (needsRefresh(ctx, entry, token, currentMs)) {
        const refreshed = refreshAuth(ctx, auth, entryKey, entry)
        if (refreshed) return { auth, entryKey, entry, token: refreshed }
        if (!isExpired(ctx, entry, token, currentMs)) {
          ctx.host.log.warn("Grok refresh failed, trying existing access token")
          return { auth, entryKey, entry, token }
        }
        expiredCandidate = true
        continue
      }
      return { auth, entryKey, entry, token }
    }

    if (expiredCandidate) {
      throw LOGIN_HINT
    }
    throw "Grok auth invalid. Run `grok login` again."
  }

  function unitsValue(obj) {
    if (!obj || typeof obj !== "object") return null
    const n = Number(obj.val)
    return Number.isFinite(n) ? n : null
  }

  function clampPercent(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    if (n < 0) return 0
    if (n > 100) return 100
    return n
  }

  function billingHeaders(token) {
    return {
      Authorization: "Bearer " + token,
      "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
      Accept: "application/json",
      "User-Agent": "OpenUsage",
    }
  }

  function fetchBilling(ctx, token, url) {
    try {
      return ctx.util.request({
        method: "GET",
        url: url,
        headers: billingHeaders(token),
        timeoutMs: 10000,
      })
    } catch {
      throw "Grok billing request failed. Check your connection."
    }
  }

  function parseBilling(ctx, resp) {
    if (ctx.util.isAuthStatus(resp.status)) {
      throw LOGIN_HINT
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Grok billing request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data) {
      throw "Grok billing response changed."
    }
    return data
  }

  function fetchPlanName(ctx, token) {
    try {
      const resp = ctx.util.request({
        method: "GET",
        url: SETTINGS_URL,
        headers: billingHeaders(token),
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) return null
      const data = ctx.util.tryParseJson(resp.bodyText)
      const plan = data && data.subscription_tier_display
      return typeof plan === "string" && plan.trim() ? plan.trim() : null
    } catch {
      return null
    }
  }

  function periodDurationMs(startIso, endIso, ctx) {
    const start = ctx.util.parseDateMs(startIso)
    const end = ctx.util.parseDateMs(endIso)
    if (start == null || end == null || end <= start) return undefined
    return end - start
  }

  function formatShortRange(ctx, startIso, endIso) {
    const start = ctx.util.parseDateMs(startIso)
    const end = ctx.util.parseDateMs(endIso)
    if (start == null || end == null) return null
    function fmt(ms) {
      const d = new Date(ms)
      const mm = String(d.getMonth() + 1).padStart(2, "0")
      const dd = String(d.getDate()).padStart(2, "0")
      const hh = String(d.getHours()).padStart(2, "0")
      const mi = String(d.getMinutes()).padStart(2, "0")
      return mm + "/" + dd + " " + hh + ":" + mi
    }
    return fmt(start) + " ~ " + fmt(end)
  }

  function productLabel(product) {
    if (!product) return "使用量"
    return PRODUCT_LABELS[product] || (String(product) + " 使用")
  }

  function buildWeeklyLines(ctx, creditsConfig) {
    const lines = []
    if (!creditsConfig || typeof creditsConfig !== "object") return lines

    const period = creditsConfig.currentPeriod
    // credits?format=credits is the weekly shared pool. Show 周限额 whenever
    // creditUsagePercent is present — do not require resetsAt (toIso can fail on
    // rare date shapes and previously caused the whole row to vanish after the
    // loading skeleton flashed 「周限额」).
    const usagePercent = Number(creditsConfig.creditUsagePercent)
    const hasUsage = Number.isFinite(usagePercent)
    const periodEnd = period && period.end ? period.end : creditsConfig.billingPeriodEnd
    const periodStart = period && period.start ? period.start : creditsConfig.billingPeriodStart
    const resetsAt = periodEnd ? ctx.util.toIso(periodEnd) : null
    const durationMs = periodStart && periodEnd
      ? periodDurationMs(periodStart, periodEnd, ctx)
      : undefined
    const rangeText = periodStart && periodEnd
      ? formatShortRange(ctx, periodStart, periodEnd)
      : null

    if (hasUsage) {
      const weeklyOpts = {
        label: "周限额",
        used: clampPercent(usagePercent),
        limit: 100,
        format: { kind: "percent" },
        color: "#22c55e",
      }
      if (resetsAt) {
        weeklyOpts.resetsAt = resetsAt
        if (durationMs) weeklyOpts.periodDurationMs = durationMs
      }
      lines.push(ctx.line.progress(weeklyOpts))
      if (rangeText) {
        lines.push(
          ctx.line.text({
            label: "周期",
            value: rangeText,
          })
        )
      }
    }

    const products = Array.isArray(creditsConfig.productUsage)
      ? creditsConfig.productUsage
      : []
    for (let i = 0; i < products.length; i++) {
      const p = products[i]
      if (!p || typeof p !== "object") continue
      const label = productLabel(p.product)
      const pct = Number(p.usagePercent)
      if (Number.isFinite(pct)) {
        lines.push(
          ctx.line.progress({
            label: label,
            used: clampPercent(pct),
            limit: 100,
            format: { kind: "percent" },
            color: "#22c55e",
          })
        )
      } else {
        lines.push(
          ctx.line.text({
            label: label,
            value: "已用 --",
          })
        )
      }
    }

    const onDemandCap = unitsValue(creditsConfig.onDemandCap)
    if (onDemandCap !== null) {
      lines.push(
        ctx.line.badge({
          label: "按量付费",
          text: onDemandCap > 0 ? "上限 " + String(onDemandCap) : "未启用",
          color: onDemandCap > 0 ? "#22c55e" : "#a3a3a3",
        })
      )
    }

    return lines
  }

  function buildMonthlyLines(ctx, monthlyConfig) {
    const lines = []
    if (!monthlyConfig || typeof monthlyConfig !== "object") return lines

    const usedUnits = unitsValue(monthlyConfig.used)
    const limitUnits = unitsValue(monthlyConfig.monthlyLimit)
    if (usedUnits === null || limitUnits === null || limitUnits <= 0) return lines

    const usedDollars = usedUnits / CENTS_PER_DOLLAR
    const limitDollars = limitUnits / CENTS_PER_DOLLAR
    const usedPercent = clampPercent((usedUnits / limitUnits) * 100)

    const periodStart = monthlyConfig.billingPeriodStart
    const periodEnd = monthlyConfig.billingPeriodEnd
    const resetsAt = periodEnd ? ctx.util.toIso(periodEnd) : null
    if (!resetsAt) return lines

    const durationMs = periodStart
      ? periodDurationMs(periodStart, periodEnd, ctx)
      : undefined

    lines.push(
      ctx.line.progress({
        label: "月度额度",
        used: usedDollars,
        limit: limitDollars,
        format: { kind: "dollars" },
        resetsAt: resetsAt,
        periodDurationMs: durationMs,
        color: "#22c55e",
      })
    )

    // Show explicit $used / $limit as a detail row (Cliproxy Plus style)
    lines.push(
      ctx.line.text({
        label: "月度用量",
        value:
          "$" +
          usedDollars.toFixed(2) +
          " / $" +
          limitDollars.toFixed(2) +
          "（" +
          Math.round(usedPercent) +
          "%）",
      })
    )

    return lines
  }

  function probe(ctx) {
    const auth = loadAuth(ctx)

    function requestWithRetry(url) {
      return ctx.util.retryOnceOnAuth({
        request: (token) => fetchBilling(ctx, token || auth.token, url),
        refresh: () => {
          const refreshed = refreshAuth(ctx, auth.auth, auth.entryKey, auth.entry)
          if (refreshed) auth.token = refreshed
          return refreshed
        },
      })
    }

    // Weekly / product pool (unified billing). Retry once — transient proxy/network
    // blips previously left users with skeleton「周限额」then only monthly lines.
    function fetchCreditsConfig() {
      const creditsResp = requestWithRetry(BILLING_CREDITS_URL)
      const creditsData = parseBilling(ctx, creditsResp)
      const cfg = creditsData && creditsData.config
      if (!cfg || typeof cfg !== "object") {
        throw "Grok credits billing config missing."
      }
      return cfg
    }

    let creditsConfig = null
    try {
      creditsConfig = fetchCreditsConfig()
    } catch (e) {
      if (typeof e === "string" && e === LOGIN_HINT) throw e
      ctx.host.log.warn("Grok credits billing first attempt failed: " + String(e))
      try {
        creditsConfig = fetchCreditsConfig()
        ctx.host.log.info("Grok credits billing succeeded on retry")
      } catch (e2) {
        if (typeof e2 === "string" && e2 === LOGIN_HINT) throw e2
        ctx.host.log.warn("Grok credits billing unavailable: " + String(e2))
      }
    }

    // Monthly included credits (units → dollars)
    let monthlyConfig = null
    try {
      const monthlyResp = requestWithRetry(BILLING_URL)
      const monthlyData = parseBilling(ctx, monthlyResp)
      monthlyConfig = monthlyData && monthlyData.config
    } catch (e) {
      if (typeof e === "string" && e === LOGIN_HINT) throw e
      // If we already have weekly data, continue; else rethrow
      if (!creditsConfig) throw e
      ctx.host.log.warn("Grok monthly billing unavailable: " + String(e))
    }

    if (!creditsConfig && !monthlyConfig) {
      throw "Grok billing response changed."
    }

    const lines = []
    const weeklyLines = buildWeeklyLines(ctx, creditsConfig)
    for (let i = 0; i < weeklyLines.length; i++) lines.push(weeklyLines[i])

    // Prefer onDemand from credits config; fall back to monthly if weekly missing it
    if (!weeklyLines.some(function (l) { return l.label === "按量付费" }) && monthlyConfig) {
      const onDemandCapUnits = unitsValue(monthlyConfig.onDemandCap)
      if (onDemandCapUnits !== null) {
        lines.push(
          ctx.line.badge({
            label: "按量付费",
            text: onDemandCapUnits > 0 ? "上限 " + String(onDemandCapUnits) : "未启用",
            color: onDemandCapUnits > 0 ? "#22c55e" : "#a3a3a3",
          })
        )
      }
    }

    const monthlyLines = buildMonthlyLines(ctx, monthlyConfig)
    for (let i = 0; i < monthlyLines.length; i++) lines.push(monthlyLines[i])

    if (lines.length === 0) {
      throw "Grok billing response changed."
    }

    return { plan: fetchPlanName(ctx, auth.token), lines: lines }
  }

  globalThis.__openusage_plugin = { id: "grok", probe }
})()
