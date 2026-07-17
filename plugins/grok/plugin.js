(function () {
  const AUTH_PATH = "~/.grok/auth.json"
  const META_FILE = "accounts-meta.json"
  const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing"
  const BILLING_CREDITS_URL = BILLING_URL + "?format=credits"
  const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
  const CHAT_URL = "https://cli-chat-proxy.grok.com/v1/chat/completions"
  const REFRESH_URL = "https://auth.x.ai/oauth2/token"
  const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
  const TOKEN_AUTH_HEADER = "xai-grok-cli"
  const CLIENT_IDENTIFIER = "grok-shell"
  const CLIENT_VERSION = "0.2.93"
  const USER_AGENT = "Grok CLI/" + CLIENT_VERSION
  const AUTH_REFRESH_BUFFER_MS = 5 * 60 * 1000
  const LOGIN_HINT = "Grok auth expired. Run `grok login` again."
  const CENTS_PER_DOLLAR = 100

  function metaPath(ctx) {
    const dir = ctx.app && ctx.app.pluginDataDir
    if (!dir) return null
    return String(dir).replace(/[\\/]+$/, "") + "/" + META_FILE
  }

  function readJson(ctx, path) {
    if (!path || !ctx.host.fs.exists(path)) return null
    try {
      return ctx.util.tryParseJson(ctx.host.fs.readText(path))
    } catch {
      return null
    }
  }

  function writeJson(ctx, path, value) {
    if (!path) return
    try {
      ctx.host.fs.writeText(path, JSON.stringify(value, null, 2))
    } catch (e) {
      ctx.host.log.warn("failed to write " + path + ": " + String(e))
    }
  }

  function loadMeta(ctx) {
    const path = metaPath(ctx)
    const data = readJson(ctx, path)
    if (!data || typeof data !== "object") return { entries: {} }
    if (!data.entries || typeof data.entries !== "object") data.entries = {}
    return data
  }

  function saveMeta(ctx, meta) {
    writeJson(ctx, metaPath(ctx), meta)
  }

  function entryMeta(meta, entryKey) {
    if (!meta || !meta.entries) return {}
    const m = meta.entries[entryKey]
    return m && typeof m === "object" ? m : {}
  }

  /**
   * Parse Play / App Store style renewal paste:
   * "Renews on July 18, 2026 · billed via Google Play" → { date: "18/07/2026", method: "Google Play" }
   */
  function parseRenewalPaste(text) {
    if (!text || typeof text !== "string") return null
    const s = text.trim()
    if (!s) return null

    let method = null
    const via = s.match(/billed via\s+(.+?)(?:\s*[·|]|$)/i) || s.match(/via\s+(.+?)(?:\s*[·|]|$)/i)
    if (via && via[1]) method = via[1].trim().replace(/\.$/, "")

    // Month name forms
    const months = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
      jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    }
    let dateStr = null
    const m1 = s.match(/Renews on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i)
    if (m1) {
      const mon = months[m1[1].toLowerCase()]
      if (mon) {
        const dd = String(Number(m1[2])).padStart(2, "0")
        const mm = String(mon).padStart(2, "0")
        dateStr = dd + "/" + mm + "/" + m1[3]
      }
    }
    if (!dateStr) {
      const m2 = s.match(/(\d{4})-(\d{2})-(\d{2})/)
      if (m2) dateStr = m2[3] + "/" + m2[2] + "/" + m2[1]
    }
    if (!dateStr) {
      const m3 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
      if (m3) {
        dateStr =
          String(Number(m3[1])).padStart(2, "0") +
          "/" +
          String(Number(m3[2])).padStart(2, "0") +
          "/" +
          m3[3]
      }
    }

    if (!dateStr && !method) return null
    return { date: dateStr, method: method }
  }

  function formatSubscriptionLine(em) {
    // Prefer structured fields; fall back to parsing raw paste.
    let date = typeof em.subscription_renews_at === "string" ? em.subscription_renews_at.trim() : ""
    let method =
      typeof em.subscription_payment_method === "string"
        ? em.subscription_payment_method.trim()
        : ""
    if ((!date || !method) && typeof em.subscription_paste === "string") {
      const parsed = parseRenewalPaste(em.subscription_paste)
      if (parsed) {
        if (!date && parsed.date) date = parsed.date
        if (!method && parsed.method) method = parsed.method
      }
    }
    // Normalize ISO date to dd/mm/YYYY
    if (/^\d{4}-\d{2}-\d{2}/.test(date)) {
      const p = date.slice(0, 10).split("-")
      date = p[2] + "/" + p[1] + "/" + p[0]
    }
    if (!date && !method) return null
    if (date && method) return date + " · " + method
    return date || method
  }

  function maskEmail(email) {
    if (!email || typeof email !== "string") return "未命名账号"
    const s = email.trim()
    const at = s.indexOf("@")
    if (at <= 0) return s
    const user = s.slice(0, at)
    const domain = s.slice(at + 1)
    if (user.length <= 3) return user[0] + "***@" + domain
    return user.slice(0, 3) + "***" + user.slice(-2) + "@" + domain
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
    const entryNeedsRefresh =
      entryMs !== null &&
      ctx.util.needsRefreshByExpiry({
        nowMs: nowMs,
        expiresAtMs: entryMs,
        bufferMs: AUTH_REFRESH_BUFFER_MS,
      })
    const tokenNeedsRefresh =
      tokenMs !== null &&
      ctx.util.needsRefreshByExpiry({
        nowMs: nowMs,
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
      ctx.host.log.warn("refresh skipped: no refresh token for " + String(entryKey))
      return null
    }

    ctx.host.log.info("attempting Grok auth refresh for " + String(entryKey))
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" +
          encodeURIComponent(readClientId(entryKey, entry)) +
          "&refresh_token=" +
          encodeURIComponent(refreshToken),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        const body = ctx.util.tryParseJson(resp.bodyText)
        const code = body && ((body.error && body.error.code) || body.error || body.code)
        ctx.host.log.error(
          "Grok auth refresh failed: status=" + resp.status + " code=" + String(code)
        )
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
      const expiresAtMs =
        Number.isFinite(expiresIn) && expiresIn > 0
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

  /** Load every usable account from ~/.grok/auth.json (multi-account). */
  function loadAllAccounts(ctx) {
    const auth = readJson(ctx, AUTH_PATH)
    if (!auth || typeof auth !== "object") {
      throw "Grok not logged in. Run `grok login`."
    }

    const currentMs = nowMs(ctx)
    const accounts = []
    let expiredOnly = false
    const keys = Object.keys(auth)

    for (let i = 0; i < keys.length; i++) {
      const entryKey = keys[i]
      const entry = auth[entryKey]
      if (!entry || typeof entry !== "object") continue
      let token = typeof entry.key === "string" ? entry.key.trim() : ""
      if (!token) continue

      if (needsRefresh(ctx, entry, token, currentMs)) {
        const refreshed = refreshAuth(ctx, auth, entryKey, entry)
        if (refreshed) {
          token = refreshed
        } else if (isExpired(ctx, entry, token, currentMs)) {
          expiredOnly = true
          accounts.push({
            auth: auth,
            entryKey: entryKey,
            entry: entry,
            token: null,
            expired: true,
          })
          continue
        }
      }

      accounts.push({
        auth: auth,
        entryKey: entryKey,
        entry: entry,
        token: token,
        expired: false,
      })
    }

    if (accounts.length === 0) {
      if (expiredOnly) throw LOGIN_HINT
      throw "Grok auth invalid. Run `grok login` again."
    }
    return accounts
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

  function safeRequest(ctx, opts) {
    try {
      return ctx.util.request(opts)
    } catch {
      return { status: 0, bodyText: "" }
    }
  }

  function fetchGet(ctx, token, url, timeoutMs) {
    return safeRequest(ctx, {
      method: "GET",
      url: url,
      headers: billingHeaders(token),
      timeoutMs: timeoutMs || 10000,
    })
  }

  function parseBillingOk(ctx, resp) {
    if (!resp || resp.status < 200 || resp.status >= 300) return null
    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || !data.config || typeof data.config !== "object") return null
    return data.config
  }

  function readJwtTier(ctx, token) {
    const payload = ctx.jwt.decodePayload(token)
    if (!payload || payload.tier === undefined || payload.tier === null) return null
    return payload.tier
  }

  function readJwtTeamId(ctx, token) {
    const payload = ctx.jwt.decodePayload(token)
    if (!payload || typeof payload.team_id !== "string" || !payload.team_id.trim()) return null
    return payload.team_id.trim()
  }

  /**
   * xAI JWT claim `tier` — account access level (社区反馈 tier=1 易被 chat gate).
   * Returns display badge text + color for the 层级 row.
   */
  function formatTierBadge(tier) {
    if (tier === null || tier === undefined || tier === "") return null
    const n = Number(tier)
    const label = Number.isFinite(n) ? "层级 " + String(n) : "层级 " + String(tier)
    // Heuristic colors — not official docs; based on community reports.
    if (Number.isFinite(n) && n <= 1) {
      return { text: label, color: "#f59e0b", note: "tier≤1 时对话接口常被 gate（HTTP 403）" }
    }
    if (Number.isFinite(n) && n >= 2) {
      return { text: label, color: "#22c55e", note: null }
    }
    return { text: label, color: "#a3a3a3", note: null }
  }

  function formatPlanWithTier(planName, tier) {
    const plan = planName && String(planName).trim() ? String(planName).trim() : null
    const tierBadge = formatTierBadge(tier)
    if (tierBadge && plan) return tierBadge.text + " · " + plan
    if (tierBadge) return tierBadge.text
    return plan || "Grok"
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

  function statusMark(ok, code) {
    if (ok) return "✓ " + String(code)
    if (!code) return "✗ —"
    return "✗ " + String(code)
  }

  function testChat(ctx, token) {
    const resp = safeRequest(ctx, {
      method: "POST",
      url: CHAT_URL,
      headers: Object.assign({}, billingHeaders(token), {
        "Content-Type": "application/json",
      }),
      bodyText: JSON.stringify({
        model: "grok-3",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      timeoutMs: 8000,
    })
    return resp.status || 0
  }

  function buildUsageLines(ctx, creditsConfig, monthlyConfig) {
    const lines = []
    const products =
      creditsConfig && Array.isArray(creditsConfig.productUsage)
        ? creditsConfig.productUsage
        : []

    const period = creditsConfig && creditsConfig.currentPeriod
    const weeklyEnd =
      period && period.end ? period.end : creditsConfig && creditsConfig.billingPeriodEnd
    const weeklyStart =
      period && period.start ? period.start : creditsConfig && creditsConfig.billingPeriodStart
    const weeklyResetsAt = weeklyEnd ? ctx.util.toIso(weeklyEnd) : null
    const weeklyDurationMs =
      weeklyStart && weeklyEnd ? periodDurationMs(weeklyStart, weeklyEnd, ctx) : undefined

    const usagePercentRaw = creditsConfig ? Number(creditsConfig.creditUsagePercent) : NaN
    const hasWeeklyPercent = Number.isFinite(usagePercentRaw)
    const weeklyPercent = hasWeeklyPercent ? clampPercent(usagePercentRaw) : null
    const isUnified = !!(creditsConfig && creditsConfig.isUnifiedBillingUser === true)

    if (isUnified) {
      lines.push(
        ctx.line.text({
          label: "账单类型",
          value: hasWeeklyPercent
            ? "统一账单 · 周限百分比已显示"
            : "统一账单 · 周限百分比未返回；已显示 Build/API",
          color: hasWeeklyPercent ? undefined : "#f59e0b",
        })
      )
    }

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
        lines.push(ctx.line.text({ label: "周重置", value: resetShort }))
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

    for (let i = 0; i < products.length; i++) {
      const p = products[i]
      if (!p || typeof p !== "object" || p.product === "GrokBuild") continue
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

    if (monthlyConfig && typeof monthlyConfig === "object") {
      const usedUnits = unitsValue(monthlyConfig.used)
      const limitUnits = unitsValue(monthlyConfig.monthlyLimit)
      if (usedUnits !== null && limitUnits !== null && limitUnits > 0) {
        const usedPercent = clampPercent((usedUnits / limitUnits) * 100)
        const periodStart = monthlyConfig.billingPeriodStart
        const periodEnd = monthlyConfig.billingPeriodEnd
        const resetsAt = periodEnd ? ctx.util.toIso(periodEnd) : null
        const durationMs =
          periodStart && periodEnd ? periodDurationMs(periodStart, periodEnd, ctx) : undefined

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

    const onDemandUsedUnits =
      creditsConfig && unitsValue(creditsConfig.onDemandUsed) !== null
        ? unitsValue(creditsConfig.onDemandUsed)
        : monthlyConfig
          ? unitsValue(monthlyConfig.onDemandUsed)
          : null
    const onDemandCapUnits =
      creditsConfig && unitsValue(creditsConfig.onDemandCap) !== null
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

    if (onDemandCapUnits !== null) {
      lines.push(
        ctx.line.badge({
          label: "按量付费",
          text:
            onDemandCapUnits > 0
              ? "上限 US$" + (onDemandCapUnits / CENTS_PER_DOLLAR).toFixed(2)
              : "未启用",
          color: onDemandCapUnits > 0 ? "#22c55e" : "#a3a3a3",
        })
      )
    }

    return { lines: lines, weeklyPercent: weeklyPercent }
  }

  function probeOneAccount(ctx, account, meta, index, total) {
    const lines = []
    const em = entryMeta(meta, account.entryKey)
    const email =
      (typeof account.entry.email === "string" && account.entry.email) ||
      (typeof account.entry.user_email === "string" && account.entry.user_email) ||
      ""
    const labels = Array.isArray(em.labels)
      ? em.labels.filter(function (x) {
          return typeof x === "string" && x.trim()
        })
      : []
    const labelText = labels.length ? " · " + labels.join(" / ") : ""

    // --- Account header ---
    lines.push(
      ctx.line.text({
        label: total > 1 ? "账号 " + String(index + 1) + "/" + String(total) : "账号",
        value: maskEmail(email) + labelText,
      })
    )

    if (account.expired || !account.token) {
      lines.push(
        ctx.line.badge({
          label: "状态",
          text: "需重新登录",
          color: "#ef4444",
        })
      )
      lines.push(
        ctx.line.text({
          label: "提示",
          value: "invalid_grant / 凭证过期，请对该账号执行 grok login",
          color: "#ef4444",
        })
      )
      return { lines: lines, plan: null, weeklyPercent: null, ok: false }
    }

    // Force refresh on 403 by pre-refreshing if near expiry already handled;
    // also try once more when billing fails with auth.
    let token = account.token

    function getWithRefresh(url) {
      let resp = fetchGet(ctx, token, url, 10000)
      if (ctx.util.isAuthStatus(resp.status)) {
        const refreshed = refreshAuth(ctx, account.auth, account.entryKey, account.entry)
        if (refreshed) {
          token = refreshed
          account.token = refreshed
          resp = fetchGet(ctx, token, url, 10000)
        }
      }
      return resp
    }

    // --- Parallel-ish sequential API tests (billing credits, plain billing, settings, chat) ---
    let creditsResp = getWithRefresh(BILLING_CREDITS_URL)
    if (creditsResp.status === 403) {
      const forced = refreshAuth(ctx, account.auth, account.entryKey, account.entry)
      if (forced) {
        token = forced
        account.token = forced
        creditsResp = fetchGet(ctx, token, BILLING_CREDITS_URL, 10000)
      }
    }
    const monthlyResp = getWithRefresh(BILLING_URL)
    const settingsResp = getWithRefresh(SETTINGS_URL)
    const chatStatus = testChat(ctx, token)

    const creditsOk = creditsResp.status >= 200 && creditsResp.status < 300
    const monthlyOk = monthlyResp.status >= 200 && monthlyResp.status < 300
    // Billing "ok" if either credits or monthly works (unified accounts)
    const billingOk = creditsOk || monthlyOk
    const billingCode = creditsOk
      ? creditsResp.status
      : monthlyOk
        ? monthlyResp.status
        : creditsResp.status || monthlyResp.status || 0
    const settingsOk = settingsResp.status >= 200 && settingsResp.status < 300
    const chatOk = chatStatus >= 200 && chatStatus < 300

    let okCount = 0
    let failCount = 0
    if (billingOk) okCount++
    else failCount++
    if (settingsOk) okCount++
    else failCount++
    if (chatOk) okCount++
    else failCount++

    const probeColor = failCount === 0 ? "#22c55e" : okCount === 0 ? "#ef4444" : "#f59e0b"
    lines.push(
      ctx.line.badge({
        label: "接口探测",
        text:
          "成功 " +
          String(okCount) +
          " · 失败 " +
          String(failCount),
        color: probeColor,
      })
    )
    lines.push(
      ctx.line.text({
        label: "探测明细",
        value:
          "billing " +
          statusMark(billingOk, billingCode) +
          " · settings " +
          statusMark(settingsOk, settingsResp.status) +
          " · chat " +
          statusMark(chatOk, chatStatus),
        color: probeColor,
      })
    )

    if (!chatOk && chatStatus === 403) {
      const tier = readJwtTier(ctx, token)
      const tierBadge = formatTierBadge(tier)
      lines.push(
        ctx.line.text({
          label: "Chat 说明",
          value:
            "对话被拒 HTTP 403" +
            (tierBadge ? " · " + tierBadge.text + (tierBadge.note ? "（" + tierBadge.note + "）" : "") : ""),
          color: "#f59e0b",
        })
      )
    }

    const creditsConfig = parseBillingOk(ctx, creditsResp)
    const monthlyConfig = parseBillingOk(ctx, monthlyResp)

    if (!creditsConfig && !monthlyConfig) {
      lines.push(
        ctx.line.badge({
          label: "状态",
          text: "账单不可用",
          color: "#ef4444",
        })
      )
      if (ctx.util.isAuthStatus(billingCode)) {
        lines.push(
          ctx.line.text({
            label: "提示",
            value: "认证失败，请重新 grok login",
            color: "#ef4444",
          })
        )
      }
      return { lines: lines, plan: null, weeklyPercent: null, ok: false }
    }

    const usage = buildUsageLines(ctx, creditsConfig, monthlyConfig)
    for (let i = 0; i < usage.lines.length; i++) lines.push(usage.lines[i])

    // Account status badge based on weekly usage
    const weeklyPercent = usage.weeklyPercent
    if (weeklyPercent !== null) {
      const limited = weeklyPercent >= 90
      lines.push(
        ctx.line.badge({
          label: "状态",
          text: limited ? "限制" : "正常",
          color: limited ? "#f59e0b" : "#22c55e",
        })
      )
    }

    // Manual subscription renew
    const subLine = formatSubscriptionLine(em)
    if (subLine) {
      lines.push(
        ctx.line.text({
          label: "订阅续费",
          value: subLine,
        })
      )
    }

    // Settings plan + JWT 层级 (tier)
    let planName = null
    if (settingsOk) {
      const data = ctx.util.tryParseJson(settingsResp.bodyText)
      const p = data && data.subscription_tier_display
      if (typeof p === "string" && p.trim()) planName = p.trim()
    }
    const tier = readJwtTier(ctx, token)
    const tierBadge = formatTierBadge(tier)
    const teamId = readJwtTeamId(ctx, token)
    const plan = formatPlanWithTier(planName, tier)

    // Show 层级 as its own badge (screenshot-style hierarchy), then 套餐 name.
    if (tierBadge) {
      lines.push(
        ctx.line.badge({
          label: "层级",
          text: tierBadge.text,
          color: tierBadge.color,
        })
      )
      if (tierBadge.note) {
        lines.push(
          ctx.line.text({
            label: "层级说明",
            value: tierBadge.note,
            color: "#a3a3a3",
          })
        )
      }
    }

    if (planName) {
      lines.push(ctx.line.text({ label: "套餐", value: planName }))
    } else if (plan) {
      lines.push(ctx.line.text({ label: "套餐", value: plan }))
    }

    if (teamId) {
      // Short team id for multi-account discrimination (not secret, but keep compact).
      const shortTeam =
        teamId.length > 12 ? teamId.slice(0, 8) + "…" + teamId.slice(-4) : teamId
      lines.push(
        ctx.line.text({
          label: "团队",
          value: shortTeam,
          color: "#a3a3a3",
        })
      )
    }

    return {
      lines: lines,
      plan: plan,
      weeklyPercent: weeklyPercent,
      ok: true,
    }
  }

  function probe(ctx) {
    const accounts = loadAllAccounts(ctx)
    const meta = loadMeta(ctx)
    // Persist skeleton meta file so users can edit labels / subscription paste.
    if (!ctx.host.fs.exists(metaPath(ctx))) {
      const seed = { entries: {}, _help: {
        labels: "字符串数组，最多 8 个标签",
        subscription_paste: "粘贴 Renews on July 18, 2026 · billed via Google Play",
        subscription_renews_at: "dd/mm/YYYY 或 YYYY-MM-DD",
        subscription_payment_method: "Google Play / App Store 等",
      } }
      for (let i = 0; i < accounts.length; i++) {
        seed.entries[accounts[i].entryKey] = entryMeta(meta, accounts[i].entryKey)
      }
      saveMeta(ctx, seed)
    }

    const allLines = []
    let primaryPlan = null
    let okAccounts = 0

    for (let i = 0; i < accounts.length; i++) {
      if (i > 0) {
        allLines.push(
          ctx.line.text({
            label: "——",
            value: "—",
            color: "#a3a3a3",
          })
        )
      }
      const result = probeOneAccount(ctx, accounts[i], meta, i, accounts.length)
      for (let j = 0; j < result.lines.length; j++) allLines.push(result.lines[j])
      if (result.ok) okAccounts++
      if (!primaryPlan && result.plan) primaryPlan = result.plan
    }

    if (allLines.length === 0) {
      throw "Grok billing response changed."
    }

    const plan =
      accounts.length > 1
        ? (primaryPlan || "Grok") + " · " + String(okAccounts) + "/" + String(accounts.length) + " 账号"
        : primaryPlan || "Grok"

    return { plan: plan, lines: allLines }
  }

  // Expose pure helpers for unit tests (optional)
  globalThis.__openusage_plugin = {
    id: "grok",
    probe: probe,
    __test: {
      parseRenewalPaste: parseRenewalPaste,
      maskEmail: maskEmail,
      formatTierBadge: formatTierBadge,
      formatPlanWithTier: formatPlanWithTier,
    },
  }
})()
