# 这事该我管吗？

面向浙江省公办小学、入职1—5年的班主任。网站保留12个经过人工核验的公开场景，并新增有限生长投稿流程：

`匿名投稿 → AI梳理 → 匹配已有场景 → 授权聚合 → 人工研究与发布`

AI不会自动生成公共政策场景，也不会判断具体学校违法。

## 本地运行

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:4173`。

- 本地演示邀请码：`TEACHER-DEMO`，最多使用3次。
- 本地管理员地址：`http://127.0.0.1:4173/admin.html`
- 本地管理员密码：`admin-demo`
- 未配置 DeepSeek 时使用本地规则模式，只用于开发验收。

## 检查

```powershell
npm test
npm run check
npm run eval:ai
```

`npm test` 验证投稿、追问、匹配、授权、撤回、删除、聚合门槛和后台操作。`npm run check` 验证公开场景及官方依据结构。配置真实 DeepSeek 密钥后，`npm run eval:ai` 使用4个代表性场景验证真实模型的匹配和提示注入抵抗。

## 生产配置

复制 `.env.example` 为 `.env`，至少配置：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`：默认 `deepseek-v4-flash`
- `APP_ENCRYPTION_KEY`：32字节密钥，支持64位十六进制或base64
- `ADMIN_PASSWORD`
- `TRUST_PROXY=true`：Nginx 需正确转发 `X-Forwarded-For`，否则所有用户会共享同一IP额度

生产环境缺少上述任一项时，服务拒绝启动。PM2 使用：

```powershell
pm2 start ecosystem.config.cjs
```

宝塔每天执行一次：

```text
cd /项目绝对路径 && node scripts/cleanup-expired.js
```

服务只监听 `127.0.0.1:4173`，由 Nginx 提供 HTTPS 和反向代理。单个 PM2 进程运行网站与接口。

## 数据与隐私

- SQLite 数据文件位于 `storage/teacher-guide.db`，使用 WAL。
- 原始投稿和追问使用 AES-256-GCM 加密保存。
- AI只接收服务端去标识化后的文字。
- 私密令牌为32字节随机值，数据库只保存 SHA-256 摘要。
- 未授权内容90天后删除；授权内容届时删除原始对话并使私密链接失效，只保留去标识化聚合结果。
- 公共场景仍由 `data.js` 维护。
