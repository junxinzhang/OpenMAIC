# Zaokit Edu 账户、订阅与积分

本次接入在 Edu 内使用 PostgreSQL 存储账户与账单，参考 Cowork
`codex/cowork-google-main` 的登录和支付流程。两个产品的账户、订阅与积分独立；
仅复用经授权的 Google/Resend/Stripe 服务配置，不读取 Cowork 用户或余额。

## 配置与启动

环境变量示例见项目根 `.env.example` 的 Zaokit Edu 段落。

- `EDU_AUTH_ENABLED=true`：使用正式账户；必须配置 `DATABASE_URL` 和可信的 `EDU_PUBLIC_ORIGIN`。
- Google：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。生产回调必须精确登记为
  `https://edu.zaokit.app/api/v1/auth/callback/google`。
- 邮箱：`RESEND_API_KEY`（或 `AUTH_RESEND_KEY`）、`AUTH_EMAIL_FROM`，发送域名需已通过验证。
- Stripe：`EDU_BILLING_ENABLED`、`EDU_BILLING_MODE`、`STRIPE_SECRET_KEY`、
  `STRIPE_WEBHOOK_SECRET`、`STRIPE_PORTAL_CONFIGURATION_ID`、`EDU_BILLING_PLANS`。
- `EDU_BILLING_ACTION_COSTS` 配置每种操作的固定积分。`agent.message` 已包含该任务内部的工具和材料提取，不重复收取工具费用。
- 浏览器存储使用 `NEXT_PUBLIC_PERSISTENCE=1`；正式账户不需要公开的旧开发 token。
- Node 版本须满足项目声明；本次用 Node 24.19.0、pnpm 10.28.0 验证。

关闭账户和积分开关时保留原单机行为。开启积分但未开启账户会拒绝启动。
根布局在运行时读取账户配置，避免 Docker 构建期间把账户开关固化为关闭。

本地 Google 验证需要在同一 Google 客户端另行登记本地回调地址。仅登记生产域名时，
本地可以验证邮箱与支付，Google 的真实授权应在生产回调可达后验收。

仓库忽略 `.env*`（保留示例）及 `client_secret_*.json`，Docker 同样排除这些文件。
本次准备的 `.env.edu.production` 是独立私密配置，正式收费保持关闭；未覆盖现有生产配置。
本地测试使用独立数据库 `zaokit_edu_test`，不使用生产课程数据库。

## 产品规则

- 支持固定月度套餐；正式价格与周期积分必须另行确定。测试商品不代表正式定价。
- 只有核验通过的已付款账单发放积分；每张账单只发一次，跳回成功页本身不授予权益。
- 积分按账期到期，不结转；已预留的任务仍使用原积分批次结算。
- 取消订阅在当前已付周期结束时生效。初版不开放升降级、差额计费或优惠券。
- 已开始的后台课程/Agent 任务按固定任务积分计费，中途取消或执行后失败不会免费重跑。
  尚未开始就失败会退回预留。同步请求明确失败可退回；网络中断、取消流或结果未知时保留待核对。
- 退款或争议会冻结对应账户的付费积分，形成核对记录；不会静默修改历史流水。
  核对期间暂停该账户 Edu 订阅的后续收款并安排期末取消，不接受新订阅。冻结不改变积分原有效期。
  初版不自动判定已消费部分是否应退款，也不自动解除付款核对状态。
- 重复客户端操作应复用 `Idempotency-Key`；再次执行同一已接收操作返回 409。
  后台任务使用持久消息/任务标识，重试不会重新扣除。

## Stripe 配置

通知地址为 `https://edu.zaokit.app/api/webhooks/stripe`，需使用该地址自己的签名密钥。
事件包括：`checkout.session.completed`、`invoice.paid`、`invoice.payment_failed`、
`customer.subscription.created/updated/deleted`、`charge.refunded`、`charge.dispute.created`。
重复事件会忽略；同步当前订阅状态以应对乱序。测试客户、账单、积分与正式环境隔离。
首次发起付款前永久保存价格对应的金额、币种和积分，后续续费使用该购买约定。
修改套餐积分必须另建 Stripe Price，不能复用旧价格 ID。

Edu 客户绑定和商品目录独立，付款元数据带 `edu_user_id`。账单金额、币种、价格、
订阅归属和数量都由服务端检查。订阅管理配置应关闭更换套餐，取消方式设为账期结束。
Checkout 使用 Edu 的显示名称，不修改共用 Stripe 账号的全局品牌。

`node --env-file=.env.local scripts/setup-edu-stripe-test.mjs` 可建立隔离的测试商品与门户配置。
脚本拒绝正式密钥，并使用固定请求标识避免重复创建测试商品。它只用于本地测试；
测试通知可使用 Stripe CLI 转发，监听器给出的密钥只保存到私密环境文件。

## 旧资料与维护

旧匿名课程和文件不会自动归给第一个登录用户，也不会删除。
正式私有内容要求账户归属；公开阅读要求明确发布。归属不明的旧内容需先核对、
备份，再由管理员明确指定归属，不能仅凭浏览器匿名标识自动领取。
各账户的本地课程/素材/设置缓存分区保存，旧匿名缓存仍保留。

在已加载部署环境后，可运行以下维护命令：

```sh
pnpm exec tsx scripts/audit-edu-ownership.ts
pnpm exec tsx scripts/reconcile-agent-billing.ts
pnpm exec tsx scripts/reconcile-edu-jobs.ts
```

归属核对是只读操作，不输出课程正文或账户标识。补偿仅处理已有明确终态证据的任务，
不根据超时猜测任务失败。服务启动后每分钟自动核对，用户关闭页面不影响后台结算。
尚在执行或状态不明的记录保留，供管理员核对。

## 上线顺序

1. 备份现有 PostgreSQL、文件课程及素材卷，保存旧镜像和原配置；运行只读归属核对。
2. 确认历史资料归属和公开范围，落实迁移映射。不要用空数据库替换现有数据库。
3. 使用独立配置构建候选镜像并验证，先保持 `EDU_BILLING_ENABLED=false`：

   ```sh
   EDU_ENV_FILE=.env.edu.production docker compose --env-file .env.edu.production -f compose.production.yml build openmaic
   ```

4. 候选环境完成 Google 真实回调、真实收件箱登录、两账户隔离和旧课程验证后切换。
5. 商业规则确定后，配置 Edu 正式价格、正式通知和专属订阅管理配置，再开启正式支付。
6. 保留旧版本回退入口。数据库变更采用新增表与字段，不删除旧课程。

本次没有替换生产容器、修改生产数据库或开放正式收费。开发验收详情见
`deploy/EDU-VERIFICATION.md`。
