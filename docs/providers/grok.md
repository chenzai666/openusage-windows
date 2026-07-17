# Grok

追踪 Grok / SuperGrok 订阅额度（周限额、Build、API 月额、按量付费），登录信息来自本机 Grok CLI。

显示风格对齐 **SuperGrok 多账号卡片**：账号脱敏、接口探测（billing / settings / chat）、健康状态、周限额、Build、API 月额度、按量、订阅续费。

> 反向工程的未公开 API，可能随时变更。

## 概览

- **协议：** REST（JSON）
- **Base URL：** `https://cli-chat-proxy.grok.com/v1`
- **认证：** `~/.grok/auth.json` 中的 Grok CLI token（**支持多账号**：文件内多个 entry 会全部探测）
- **刷新：** 同文件中的 refresh_token；HTTP 403 会强制 refresh 再试
- **计划名：** `GET /settings` → `subscription_tier_display`，并拼 JWT `tier`
- **本地元数据：** `%APPDATA%\com.openusage.windows\plugins_data\grok\accounts-meta.json`  
  （标签、订阅续费粘贴；首次探测时自动创建模板）

## 设置

1. 安装并登录 Grok CLI（可多次登录多账号，写入同一 `auth.json`）：

```bash
grok login
```

2. 在 OpenUsage 设置中启用 Grok 插件。

3. （可选）编辑 `accounts-meta.json`：

```json
{
  "entries": {
    "https://auth.x.ai::<clientId>": {
      "labels": ["周02"],
      "subscription_paste": "Renews on July 18, 2026 · billed via Google Play"
    }
  }
}
```

粘贴文案会解析为 **`18/07/2026 · Google Play`**。

## 请求头

对齐官方 Grok CLI，降低 403：

```
Authorization: Bearer <token>
X-XAI-Token-Auth: xai-grok-cli
X-Grok-Client-Identifier: grok-shell
X-Grok-Client-Version: 0.2.93
User-Agent: Grok CLI/0.2.93
```

## 接口

| 用途 | URL |
|------|-----|
| 周限 + productUsage | `GET /billing?format=credits` |
| API 月额度 | `GET /billing` |
| 套餐名 | `GET /settings` |
| 对话可用性 | `POST /chat/completions`（model `grok-3`，`max_tokens: 1`） |

### GET /billing?format=credits

| 字段 | 含义 |
|------|------|
| `currentPeriod` | 周期类型（周）、起止时间 |
| `creditUsagePercent` | 周共享池已用百分比 |
| `productUsage[]` | GrokBuild / GrokChat 等 |
| `onDemandCap` / `onDemandUsed` | 按量付费 |
| `isUnifiedBillingUser` | 是否统一账单 |

### GET /billing

| 字段 | 含义 |
|------|------|
| `used.val` / `monthlyLimit.val` | 月度用量单位（**分**，÷100 = 美元） |
| `billingPeriodStart` / `End` | 月度账期 / 重置 |

## 显示行

| 行 | 说明 |
|----|------|
| **账号** | 脱敏邮箱 + 可选标签 |
| **接口探测** | billing / settings / chat 成功失败计数 |
| **探测明细** | 各接口 ✓/✗ + HTTP 状态 |
| **Chat 说明** | chat 403 时的 gate 提示 |
| **账单类型** | 统一账单提示 |
| **健康状态（周限）** | 周限 % 进度 |
| **周限额** / **周重置** | 周共享池 |
| **Build 用量** | GrokBuild；无字段则提示 |
| **API 月额度** / **API 明细** | 月度 used/limit + 美元 |
| **按量已用** / **按量付费** | 按量 |
| **状态** | 正常 / 限制 / 需重新登录 |
| **订阅续费** | 手动元数据解析结果 |
| **套餐** | `tier N · SuperGrok` |

多账号时按账号分段，中间用分隔行，plan 显示 `… · k/n 账号`。

## 错误

| 条件 | 提示 |
|------|------|
| 无登录 | `Grok not logged in. Run \`grok login\`.` |
| 单账号过期 | 该段显示「需重新登录」（不拖垮其它账号） |
| 全部不可用 | 各账号段内提示 |
| 响应结构变化 | `Grok billing response changed.` |
