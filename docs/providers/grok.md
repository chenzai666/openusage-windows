# Grok

追踪 Grok / SuperGrok 订阅额度（周限额、Build、API 月额、按量付费），登录信息来自本机 Grok CLI。

显示风格对齐 **设计稿 / SuperGrok 多账号卡片**（见产品截图）：

- 每账号一张卡：xAI 徽章、状态（正常/限制）、标签、邮箱脱敏  
- `层级 N · SuperGrok · 刷新时间`  
- 统一账单提示条  
- 接口探测：成功/失败 + billing / settings / chat 标签  
- 健康状态点条、周限额、Build 用量、API 月额度、按量已用/付费  
- 底栏：测试 / 刷新 / 设置 / 删除 / 启用（托盘账号）

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

1. 在 OpenUsage **设置 → 提供商插件** 中启用 Grok。
2. 同一页底部 **Grok 账号** 区块：
   - **添加 / 重新登录**：device-code 流程，**复制链接到剪贴板**（不自动打开浏览器），在浏览器完成授权后写入 `~/.grok/auth.json`
   - 也可继续用 CLI：`grok login`
   - 为每个账号编辑 **标签**、**订阅续费粘贴**（如 `Renews on July 18, 2026 · billed via Google Play` → `18/07/2026 · Google Play`）
3. 元数据仍保存在  
   `%APPDATA%\com.openusage.windows\plugins_data\grok\accounts-meta.json`  
   （设置页保存会自动写此文件）

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
| **层级** | JWT claim `tier`（徽章，如「层级 1」；≤1 时提示 chat 可能被 gate） |
| **套餐** | settings `subscription_tier_display`（如 SuperGrok） |
| **团队** | JWT `team_id` 缩写（多账号区分） |
| **卡片标题 plan** | `层级 N · SuperGrok` |

多账号时按账号分段，中间用分隔行，plan 显示 `… · k/n 账号`。

## 错误

| 条件 | 提示 |
|------|------|
| 无登录 | `Grok not logged in. Run \`grok login\`.` |
| 单账号过期 | 该段显示「需重新登录」（不拖垮其它账号） |
| 全部不可用 | 各账号段内提示 |
| 响应结构变化 | `Grok billing response changed.` |
