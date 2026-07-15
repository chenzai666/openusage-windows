# Grok

追踪 Grok / SuperGrok 订阅额度（周限额、产品用量、月度额度），登录信息来自本机 Grok CLI。

显示风格对齐 **Cliproxy Plus** 额度卡片：周限额、各产品使用、按量付费、月度额度及重置时间。

> 反向工程的未公开 API，可能随时变更。

## 概览

- **协议：** REST（JSON）
- **Base URL：** `https://cli-chat-proxy.grok.com/v1`
- **认证：** `~/.grok/auth.json` 中的 Grok CLI token
- **刷新：** 同文件中的 refresh_token
- **计划名：** `GET /settings` → `subscription_tier_display`

## 设置

1. 安装并登录 Grok CLI：

```bash
grok login
```

2. 在 OpenUsage 设置中启用 Grok 插件。

## 接口

### GET /billing?format=credits（周限额 / 产品拆分）

统一计费账号返回：

| 字段 | 含义 |
|------|------|
| `currentPeriod` | 周期类型（周）、起止时间 |
| `creditUsagePercent` | 周共享池已用百分比 |
| `productUsage[]` | GrokBuild / GrokChat 等分产品占比 |
| `onDemandCap` | 按量付费上限（0 = 未启用） |
| `isUnifiedBillingUser` | 是否已迁移到周共享池 |

### GET /billing（月度额度）

| 字段 | 含义 |
|------|------|
| `used.val` / `monthlyLimit.val` | 月度用量单位（**分**，÷100 = 美元） |
| `billingPeriodStart` / `End` | 月度账期起止 / 重置时间 |
| `onDemandCap` | 按量付费上限 |

## 显示行

| 行 | 说明 |
|----|------|
| **周限额** | 周共享池已用 %，含重置时间与周期范围 |
| **周期** | 本周起止（本地时间格式） |
| **GrokBuild / GrokChat 使用** | 分产品用量（无数据时显示「已用 --」） |
| **按量付费** | 未启用 / 上限数值 |
| **月度额度** | 按美元显示的月度已用（progress） |
| **月度用量** | `$已用 / $上限（%）` 明细 |

## 错误

| 条件 | 提示 |
|------|------|
| 无登录 | `Grok not logged in. Run \`grok login\`.` |
| 登录过期 | `Grok auth expired. Run \`grok login\` again.` |
| 网络/HTTP 错误 | `Grok billing request failed...` |
| 响应结构变化 | `Grok billing response changed.` |
