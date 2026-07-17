(function () {
  const AUTH_PATH = "~/.grok/auth.json"
  const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
  const BILLING_CREDITS_URL = BILLING_URL + "?format=credits"
  const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
  const REFRESH_URL = "https://auth.x.ai/oauth2/token"
  const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
  const TOKEN_AUTH_HEADER = "xai-grok-cli"
  // Align with official Grok CLI so cli-chat-proxy is less likely to 403.
  const CLIENT_IDENTIFIER = "grok-shell"
  const CLIENT_VERSION = "0.2.93"
  const USER_AGENT = "Grok CLI/" + CLIENT_VERSION
  const AUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000
  const LOGIN_HINT = "Grok auth expired. Run `grok login` again."

  // Grok CLI billing units are reported in cents ($1.00 = 100).
  const CENTS_PER_DOLLAR = 100

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

  function healthColor(percent) {
    if (percent >= 90) return "#ef4444"
    if (percent >= 70) return "#f59e0b"
    return "#22c55e"
  }

  function billingHeaders(token) {
    return {
      Authorization: "Bearer " + token,
      "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
      "X-Grok-Client-Identifier": CLIENT_IDENTIFIER,
      "X-Grok-Client-Version": CLIENT_VERSION,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
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

  function fetchSettings(ctx, token) {
    try {
      const resp = ctx.util.request({
        method: "GET",
        url: SETTINGS_URL,
        headers: billingHeaders(token),
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        return { plan: null, ok: false, status: resp.status }
      }
      const data = ctx.util.tryParseJson(resp.bodyText)
      const plan = data && data.subscription_tier_display
      return {
        plan: typeof plan === "string" && plan.trim() ? plan.trim() : null,
        ok: true,
        status: resp.status,
      }
    } catch {
      return { plan: null, ok: false, status: 0 }
    }
  }

  function readJwtTier(ctx, token) {
    const payload = ctx.jwt.decodePayload(token)
    if (!payload || payload.tier === undefined || payload.tier === null) return null
    return payload.tier
  }

  function periodDurationMs(startIso, endIso, ctx) {
    const start = ctx.util.parseDateMs(startIso)
    const end = ctx.util.parseDateMs(endIso)
    if (start == null || end == null || end <= start) return undefined
    return end - start
  }

  function formatResetShort(ctx, endIso) {
    const end = ctx.util.parseDateMs(endIso)
    if (end == null) return null
    const d = new Date(end)
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const dd = String(d.getDate()).padStart(2, "0")
    const hh = String(d.getHours()).padStart(2, "0")
    const mi = String(d.getMinutes()).padStart(2, "0")
    return mm + "/" + dd + " " + hh + ":" + mi
  }

  function findProduct(products, name) {
    if (!Array.isArray(products)) return null
    for (let i = 0; i < products.length; i++) {
      const p = products[i]
      if (p && p.product === name) return p
    }
    return null
  }

  /**
   * Build card lines to match the SuperGrok usage card layout:
   * 健康状态 / 周限额 / Build 用量 / API 月额度 / 按量已用 / 按量付费
   */
  function buildLines(ctx, creditsConfig, monthlyConfig) {
    const lines = []
    const products = creditsConfig && Array.isArray(creditsConfig.productUsage)
      ? creditsConfig.productUsage
      : []

    const period = creditsConfig && creditsConfig.currentPeriod
    const weeklyEnd = period && period.end
      ? period.end
      : creditsConfig && creditsConfig.billingPeriodEnd
    const weeklyStart = period && period.start
      ? period.start
      : creditsConfig && creditsConfig.billingPeriodStart
    const weeklyResetsAt = weeklyEnd ? ctx.util.toIso(weeklyEnd) : null
    const weeklyDurationMs = weeklyStart && weeklyEnd
      ? periodDurationMs(weeklyStart, weeklyEnd, ctx)
      : undefined

    const usagePercentRaw = creditsConfig ? Number(creditsConfig.creditUsagePercent) : NaN
    const hasWeeklyPercent = Number.isFinite(usagePercentRaw)
    const weeklyPercent = hasWeeklyPercent ? clampPercent(usagePercentRaw) : null

    const isUnified = !!(creditsConfig && creditsConfig.isUnifiedBillingUser === true)

    // --- 账单提示（统一账单 / 周限缺失）---
    if (isUnified) {
      if (hasWeeklyPercent) {
        lines.push(
          ctx.line.text({
            label: "账单类型",
            value: "统一账单 · 周限百分比已显示",
          })
        )
      } else {
        lines.push(
          ctx.line.text({
            label: "账单类型",
            value: "统一账单 · 周限百分比未返回；已显示 Build/API",
            color: "#f59e0b",
          })
        )
      }
    }

    // --- 健康状态（周限）---
    if (weeklyPercent !== null) {
      const healthOpts = {
        label: "健康状态（周限）",
        used: weeklyPercent,
        limit: 100,
        format: { kind: "percent" },
        color: healthColor(weeklyPercent),
      }
      if (weeklyResetsAt) {
        healthOpts.resetsAt = weeklyResetsAt
        if (weeklyDurationMs) healthOpts.periodDurationMs = weeklyDurationMs
      }
      lines.push(ctx.line.progress(healthOpts))
    }

    // --- 周限额 ---
    if (weeklyPercent !== null) {
      const weeklyOpts = {
        label: "周限额",
        used: weeklyPercent,
        limit: 100,
        format: { kind: "percent" },
        color: healthColor(weeklyPercent),
      }
      if (weeklyResetsAt) {
        weeklyOpts.resetsAt = weeklyResetsAt
        if (weeklyDurationMs) weeklyOpts.periodDurationMs = weeklyDurationMs
      }
      lines.push(ctx.line.progress(weeklyOpts))
      const resetShort = weeklyEnd ? formatResetShort(ctx, weeklyEnd) : null
      if (resetShort) {
        lines.push(
          ctx.line.text({
            label: "周重置",
            value: resetShort,
          })
        )
      }
    } else if (creditsConfig) {
      lines.push(
        ctx.line.text({
          label: "周限额",
          value: "接口未返回 creditUsagePercent",
          color: "#a3a3a3",
        })
      )
    }

    // --- Build 用量（GrokBuild）---
    const build = findProduct(products, "GrokBuild")
    if (build && Number.isFinite(Number(build.usagePercent))) {
      const buildPct = clampPercent(Number(build.usagePercent))
      lines.push(
        ctx.line.progress({
          label: "Build 用量",
          used: buildPct,
          limit: 100,
          format: { kind: "percent" },
          color: healthColor(buildPct),
        })
      )
    } else {
      lines.push(
        ctx.line.text({
          label: "Build 用量",
          value: "接口未返回 Build 字段",
          color: "#a3a3a3",
        })
      )
    }

    // --- 其它 productUsage（Chat/Imagine/Voice 等，有百分比才显示）---
    for (let i = 0; i < products.length; i++) {
      const p = products[i]
      if (!p || typeof p !== "object") continue
      if (p.product === "GrokBuild") continue
      const pct = Number(p.usagePercent)
      if (!Number.isFinite(pct)) continue
      const label =
        p.product === "GrokChat"
          ? "Chat 用量"
          : p.product === "GrokImagine"
            ? "Imagine 用量"
            : p.product === "GrokVoice"
              ? "Voice 用量"
              : String(p.product || "产品") + " 用量"
      lines.push(
        ctx.line.progress({
          label: label,
          used: clampPercent(pct),
          limit: 100,
          format: { kind: "percent" },
          color: healthColor(clampPercent(pct)),
        })
      )
    }

    // --- API 月额度（plain billing units，截图风格 已用 x / limit）---
    if (monthlyConfig && typeof monthlyConfig === "object") {
      const usedUnits = unitsValue(monthlyConfig.used)
      const limitUnits = unitsValue(monthlyConfig.monthlyLimit)
      if (usedUnits !== null && limitUnits !== null && limitUnits > 0) {
        const usedPercent = clampPercent((usedUnits / limitUnits) * 100)
        const periodStart = monthlyConfig.billingPeriodStart
        const periodEnd = monthlyConfig.billingPeriodEnd
        const resetsAt = periodEnd ? ctx.util.toIso(periodEnd) : null
        const durationMs = periodStart && periodEnd
          ? periodDurationMs(periodStart, periodEnd, ctx)
          : undefined

        const apiOpts = {
          label: "API 月额度",
          used: usedUnits,
          limit: limitUnits,
          format: { kind: "count", suffix: "" },
          color: healthColor(usedPercent),
        }
        if (resetsAt) {
          apiOpts.resetsAt = resetsAt
          if (durationMs) apiOpts.periodDurationMs = durationMs
        }
        lines.push(ctx.line.progress(apiOpts))

        const usedDollars = usedUnits / CENTS_PER_DOLLAR
        const limitDollars = limitUnits / CENTS_PER_DOLLAR
        lines.push(
          ctx.line.text({
            label: "API 明细",
            value:
              Math.round(usedPercent) +
              "% · " +
              String(usedUnits) +
              " / " +
              String(limitUnits) +
              "（$" +
              usedDollars.toFixed(2) +
              " / $" +
              limitDollars.toFixed(2) +
              "）",
          })
        )
      }
    }

    // --- 按量已用 ---
    const onDemandUsedUnits =
      (creditsConfig && unitsValue(creditsConfig.onDemandUsed)) !== null
        ? unitsValue(creditsConfig.onDemandUsed)
        : monthlyConfig
          ? unitsValue(monthlyConfig.onDemandUsed)
          : null
    const onDemandCapUnits =
      (creditsConfig && unitsValue(creditsConfig.onDemandCap)) !== null
        ? unitsValue(creditsConfig.onDemandCap)
        : monthlyConfig
          ? unitsValue(monthlyConfig.onDemandCap)
          : null

    if (onDemandUsedUnits !== null || onDemandCapUnits !== null) {
      const usedUsd =
        onDemandUsedUnits !== null
          ? (onDemandUsedUnits / CENTS_PER_DOLLAR).toFixed(2)
          : "--"
      const capUsd =
        onDemandCapUnits !== null && onDemandCapUnits > 0
          ? (onDemandCapUnits / CENTS_PER_DOLLAR).toFixed(2)
          : "--"
      const resetHint = weeklyEnd ? formatResetShort(ctx, weeklyEnd) : null
      lines.push(
        ctx.line.text({
          label: "按量已用",
          value:
            "US$" +
            usedUsd +
            " / " +
            (capUsd === "--" ? "--" : "US$" + capUsd) +
            (resetHint ? " · 重置 " + resetHint : ""),
        })
      )
    }

    // --- 按量付费 ---
    if (onDemandCapUnits !== null) {
      lines.push(
        ctx.line.badge({
          label: "按量付费",
          text: onDemandCapUnits > 0 ? "上限 US$" + (onDemandCapUnits / CENTS_PER_DOLLAR).toFixed(2) : "未启用",
          color: onDemandCapUnits > 0 ? "#22c55e" : "#a3a3a3",
        })
      )
    }

    return lines
  }

  function probe(ctx) {
    const auth = loadAuth(ctx)

    function requestWithRetry(url) {
      // 401/403 → force refresh even if JWT claims not expired (xAI gate quirks).
      return ctx.util.retryOnceOnAuth({
        request: (token) => fetchBilling(ctx, token || auth.token, url),
        refresh: () => {
          const refreshed = refreshAuth(ctx, auth.auth, auth.entryKey, auth.entry)
          if (refreshed) auth.token = refreshed
          return refreshed
        },
      })
    }

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
        // On hard 403 paths, force a refresh then retry once more.
        const forced = refreshAuth(ctx, auth.auth, auth.entryKey, auth.entry)
        if (forced) auth.token = forced
        creditsConfig = fetchCreditsConfig()
        ctx.host.log.info("Grok credits billing succeeded on retry")
      } catch (e2) {
        if (typeof e2 === "string" && e2 === LOGIN_HINT) throw e2
        ctx.host.log.warn("Grok credits billing unavailable: " + String(e2))
      }
    }

    let monthlyConfig = null
    try {
      const monthlyResp = requestWithRetry(BILLING_URL)
      const monthlyData = parseBilling(ctx, monthlyResp)
      monthlyConfig = monthlyData && monthlyData.config
    } catch (e) {
      if (typeof e === "string" && e === LOGIN_HINT) throw e
      if (!creditsConfig) throw e
      ctx.host.log.warn("Grok monthly billing unavailable: " + String(e))
    }

    if (!creditsConfig && !monthlyConfig) {
      throw "Grok billing response changed."
    }

    const lines = buildLines(ctx, creditsConfig, monthlyConfig)
    if (lines.length === 0) {
      throw "Grok billing response changed."
    }

    const settings = fetchSettings(ctx, auth.token)
    const tier = readJwtTier(ctx, auth.token)
    let plan = settings.plan || "Grok"
    if (tier !== null && tier !== undefined && tier !== "") {
      plan = "tier " + String(tier) + " · " + plan
    }

    return { plan: plan, lines: lines }
  }

  globalThis.__openusage_plugin = { id: "grok", probe }
})()
