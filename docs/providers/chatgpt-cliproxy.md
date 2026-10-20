# ChatGPT / Codex 卡片与 CLIProxy 导入

ChatGPT / Codex 面板沿用 Grok 的深色卡片设计：账号与套餐标签、周额度健康圆点、细进度条、刷新时间、底部操作栏，以及可展开的多列工作台。首页和提供商详情页使用同一组件，按实际返回数据展示会话、周额度、Spark、代码审查和积分。

## 导入步骤

1. 使用完整版 OpenUsage，在设置的提供商插件中启用 **Codex**。Grok 专用安装包仍只显示 Grok。
2. 进入 **设置 → ChatGPT / Codex 账号 → 导入 CLIProxy JSON**。
3. 从 CLIProxy 的 `auth-dir` 选择 Codex OAuth 账号文件，支持一次多选。也可以展开「粘贴 JSON 导入」，粘贴单个账号、JSON 数组或带 `accounts` 数组的对象。
4. 导入后自动刷新用量。多个账号分别显示卡片，一个账号查询失败时，其余账号继续显示。
5. 在卡片底部点击 **设为托盘** 选择托盘指标来源；点击 **展开工作台** 使用宽窗口查看多账号，按 Esc 收起。

接受 CLIProxy 导出的扁平格式，以及原生 Codex 的 `tokens` 嵌套格式。例如以下内容仅用于说明结构，所有值都是占位符：

```json
{
  "type": "codex",
  "email": "demo@example.com",
  "account_id": "account-id-placeholder",
  "access_token": "access-token-placeholder"
}
```

同一 `account_id` 再次导入会更新已有账号；缺少该字段时尝试从 JWT 提取账号 ID，再使用邮箱或凭据摘要标识账号。每次最多选择 20 个文件，每个文件不超过 1 MiB，应用最多保存 20 个导入账号。整批内容先校验，再一次性替换加密存储；格式错误时保留原有账号。

`config.yaml`、API Key、仅含账号名称/状态的管理接口列表不包含查询订阅额度所需的 OAuth 凭据。请使用实际的 Codex 账号 JSON，而不是服务端主配置或列表导出。

## 凭据安全与续期

- 导入副本通过 Windows DPAPI 加密，绑定当前 Windows 用户，保存在应用数据目录的 `plugins_data/codex/cliproxy-accounts.dpapi`。
- 不修改 CLIProxy 源文件、`~/.codex/auth.json` 或 `CODEX_HOME/auth.json`。移除账号仅删除应用内副本，移除前会要求确认。
- **不复制、不使用导入账号的 refresh_token**，避免与 CLIProxy 争用轮换令牌。凭据到期时卡片提示重新导入 CLIProxy 最新账号 JSON。本机原生 Codex 登录仍沿用原来的刷新逻辑。
- 凭据只用于固定的 OpenAI 用量接口，不采用导入文件内的自定义 URL、代理地址或请求头，不发送测试对话。
- 设置列表、卡片数据和托盘只接收脱敏显示信息与用量，不接收凭据。粘贴输入成功后自动清空。
- 请妥善保管 CLIProxy 导出的原始 JSON，不上传至 Git、工单或公共分享位置。迁移到其他 Windows 用户/设备时重新导入，不直接搬运 DPAPI 文件。

## 指标说明

### 使用额度重置卡

每张账号卡片提供「额度重置卡」操作区，显示可用张数。有卡时点击 **使用重置卡**，程序先重新查询服务端可用数量，再弹出账号与消耗确认。确认后使用一张重置卡，处理结果显示在面板内，并自动刷新用量。

重置接口遵循 OpenAI Codex 官方实现：`GET /backend-api/wham/rate-limit-reset-credits` 查询，`POST /backend-api/wham/rate-limit-reset-credits/consume` 使用，提交 `redeem_request_id` 幂等编号。支持 `reset`、`nothing_to_reset`、`no_credit`、`already_redeemed` 四种结果。具体重置窗口由服务端决定。

该操作会消耗账号资源，必须逐次确认；不会定时或自动使用。提交过程中禁用重复点击。网络超时等结果不明时保留加密的请求编号，提供「核对重置结果」，后续重试复用原编号，避免重复消耗。确认后如果账号身份已变化，后端拒绝提交。

接口依据：[官方 App Server 文档](https://developers.openai.com/codex/app-server)、[官方后端客户端实现](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)。

订阅额度来自现有 Codex 用量接口；本机今日/昨日/近 30 天费用与趋势来自本机 Codex 会话统计，仅展示在本机账号卡片中。导入账号的卡片只展示该账号接口实际返回的额度和积分，避免混入本机会话费用。

圆点表示剩余额度，进度条遵循设置中的「已用 / 剩余」模式。缺失或无效的额度显示为暂无数据。刷新中保留已有内容，刷新按钮遵循原有冷却时间；导入、移除和托盘选择完成后触发独立刷新。

## 验证

```powershell
npm ci
npm run bundle:plugins
npm run build
npm test
```

Windows 原生 DPAPI 存储、解析与去重测试，以及安装包构建由 GitHub Actions 的 **ChatGPT Windows 验证构建** 工作流执行。工作流只上传安装包，不自动创建正式发布。

使用实际账号验收时，先导入一个账号，检查脱敏身份、套餐、会话/周额度；再导入多个账号并切换托盘来源。最后检查错误 JSON 被拒绝、过期账号独立提示、移除后卡片消失，以及 CLIProxy 和本机 Codex 的源文件内容保持不变。
