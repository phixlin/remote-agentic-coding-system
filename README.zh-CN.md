# Dynamous Remote Coding Agent（中文指南）

> 英文原版请参阅 `README.md`。本文档概述如何在中文环境下部署、配置并使用 Remote Coding Agent。

## 项目简介

Remote Coding Agent 可以让 Claude Code 或 Codex 等 AI 编程助手，通过 Telegram、GitHub、飞书等入口远程操控任意代码仓库。它提供持久化的会话、命令体系以及 Docker 化部署，帮助你在任何地点进行协作开发。

## 功能亮点

- **多平台入口**：支持 Telegram Bot、GitHub Issue/PR 评论、飞书机器人，可按需扩展更多 IM 平台。
- **多 AI 引擎**：同一套流程中可选择 Claude 或 Codex，并可针对具体代码仓库持久化上下文。
- **持久化会话**：Conversation / Session 信息全部写入 PostgreSQL，容器重启后仍能继续。
- **命令体系**：通过 `/command-invoke` 等命令执行存放在 `.claude/commands`、`.agents/commands` 中的 Markdown 模板。
- **实时/批量响应**：Telegram 走流式推送，GitHub 采用批量总结，飞书默认为流式（可改批量）。
- **Docker 一键部署**：内置 `docker-compose`，可快速在本地或云服务器启动。

## 环境与账户要求

| 分类 | 说明 |
| ---- | ---- |
| 系统 | Docker / Docker Compose（部署），Node.js 20+（本地开发） |
| 账户 | GitHub（用于 `/clone` 和 webhook），以及至少一个交互渠道：Telegram 或 GitHub 或飞书 |
| AI 凭证 | Claude Pro/Max **或** Codex 账号，亦可同时配置 |
| 数据库 | PostgreSQL（可使用 docker profile `with-db` 或远程服务如 Supabase/Neon） |

## 快速开始

```bash
git clone https://github.com/coleam00/remote-agentic-coding-system
cd remote-agentic-coding-system
cp .env.example .env       # 根据下文填写变量
npm install                # 本地开发环境
```

### 1. 核心配置（必填）

1. 设置 `DATABASE_URL` 指向 PostgreSQL。若使用 `docker compose --profile with-db`，使用示例中提供的默认值即可。
2. 在 GitHub 个人设置中创建 `repo` 权限的 Personal Access Token，分别填入 `GH_TOKEN`、`GITHUB_TOKEN`。
3. （可选）调整 `PORT`、`WORKSPACE_PATH`、`MAX_CONCURRENT_CONVERSATIONS` 等参数。

### 2. AI 助手配置（至少一种）

- **Claude Code**：配置 `CLAUDE_CODE_OAUTH_TOKEN`（推荐）或 `CLAUDE_API_KEY`。
- **Codex**：运行 `codex login` 后，从 `~/.codex/auth.json` 中取得 `CODEX_ID_TOKEN`、`CODEX_ACCESS_TOKEN`、`CODEX_REFRESH_TOKEN`、`CODEX_ACCOUNT_ID`。

将 `DEFAULT_AI_ASSISTANT` 设为 `claude` 或 `codex`，用于尚未绑定代码仓库的会话。

### 3. 平台适配器设置（至少一个）

#### Telegram

1. 和 [@BotFather](https://t.me/BotFather) 对话 → `/newbot` → 获得 `TELEGRAM_BOT_TOKEN`。
2. 可选：`TELEGRAM_STREAMING_MODE=stream|batch` 控制推送方式。

#### GitHub Webhook

1. 生成 `WEBHOOK_SECRET`（`openssl rand -hex 32`）。
2. 暴露服务 `https://<domain>/webhooks/github`（本地可用 ngrok/Cloudflare Tunnel）。
3. 在仓库 Settings → Webhooks 中勾选 Issues / Issue comments / Pull requests。
4. 将 `WEBHOOK_SECRET` 写入 `.env`；可用 `GITHUB_STREAMING_MODE=batch|stream` 切换模式。

#### 飞书（Feishu / Lark）

1. 在 [飞书开发者后台](https://open.feishu.cn/) 创建应用，启用 Bot。
2. 授权 `im:message` / `im:message.group` / `im:message.p2p` 等权限，并发布应用。
3. 在“事件订阅”中配置：
   - 请求地址：`https://<domain>/webhooks/feishu`
   - 关闭加密（当前适配器只接受明文 JSON）
   - 订阅 `im.message.receive_v1`
   - 记录 “Verification Token”
4. `.env` 中至少配置：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
FEISHU_STREAMING_MODE=stream   # 或 batch
FEISHU_BOT_OPEN_ID=ou_xxx      # 可选，严格判断 @ 提及
FEISHU_REQUIRE_GROUP_MENTION=true  # true=群聊必须@bot才响应
```

> 本地调试时同样需要通过 ngrok/Cloudflare 暴露端口。

### 4. 启动服务

| 场景 | 命令 |
| ---- | ---- |
| 本地 Node.js 开发 | `npm run dev` |
| Docker + 远程数据库 | `docker compose --profile external-db up -d --build` |
| Docker + 内置 PostgreSQL | `docker compose --profile with-db up -d --build` |

常见辅助命令：

```bash
docker compose logs -f app            # 查看日志（external-db profile）
docker compose logs -f app-with-db    # 查看日志（with-db profile）
docker compose down                   # 停止并移除容器
```

## 常用 Slash 命令

| 命令 | 作用 |
| ---- | ---- |
| `/help` | 查看所有命令说明 |
| `/clone <repo-url>` | 克隆 Git 仓库到 `/workspace/<repo>` 并绑定会话 |
| `/repos` | 列出当前工作区中的仓库 |
| `/status` | 查看平台、AI、代码仓库与 Session 状态 |
| `/getcwd` / `/setcwd <path>` | 查看/修改当前工作目录（修改后会重置 Session） |
| `/command-set <name> <path>` | 注册单个 Markdown 命令 |
| `/load-commands <folder>` | 递归导入某个目录下的所有 `.md` 命令 |
| `/command-invoke <name> [args]` | 执行命令文件（支持参数替换） |
| `/commands` | 查看已注册命令列表 |
| `/reset` | 清理当前会话的活跃 Session |

## 典型工作流

1. 使用 `/clone` 拉取目标仓库，系统会自动探测 `.claude/commands` 并建议使用的 AI。
2. 用 `/load-commands` 导入命令模板（如 plan / execute / validate）。
3. 通过 `/command-invoke plan "需求"` 获取实现计划，再执行 `/command-invoke execute` 进入实施阶段；期间 AI 会在仓库工作目录执行命令。
4. 如需切换仓库或目录，使用 `/setcwd` 并重新开始对话；GitHub/飞书入口同样遵循上述命令体系。

## 故障排查提示

- PostgreSQL 连接失败 → 查看 `DATABASE_URL`、`docker compose logs postgres`。
- GitHub Webhook 无响应 → 检查 `WEBHOOK_SECRET`、ngrok/Cloudflare 隧道以及 GitHub “Recent Deliveries”。
- 飞书消息未触发 → 确认事件订阅已启用、`verification token` 一致、是否在群聊中 @ 了机器人。
- AI 会话卡住 → `/reset` 后重试；或检查 Claude/Codex 凭证是否过期。

## 代理/翻墙环境

在部分地区访问 Telegram、飞书或 GitHub 需要经过代理。最简单的方式是在 `docker-compose.yml` 中为 `app` / `app-with-db` 服务设置代理环境变量，让容器内的 Codex、Telegram/飞书 适配器全部借助 Clash/Sing-box 等代理出网：

```yaml
services:
  app-with-db:
    environment:
      HTTP_PROXY:  http://172.17.0.1:7890
      HTTPS_PROXY: http://172.17.0.1:7890
      NO_PROXY:    localhost,127.0.0.1,postgres,app-with-db
```

- `172.17.0.1` 是宿主机在默认 Docker 网桥中的 IP（如果你使用自定义网络，请替换为实际地址）。
- `7890` 替换为 Clash/Sing-box 暴露的 HTTP 端口；如果走 socks5，请写成 `socks5://172.17.0.1:7891`。
- 确保代理程序开启 `allow-lan`，容器才能访问宿主机端口。
- 想快速验证代理是否生效，可在宿主机先执行 `export https_proxy=http://127.0.0.1:7890 && curl https://api.telegram.org`。

按照上述方式修改 compose 文件并 `docker compose up -d` 之后，Codex、Telegram、飞书、GitHub 等组件都会自动走代理，无需单独配置。

## 更多文档

- `README.md`：英文版完整说明。
- `docs/architecture.md`：系统架构、扩展指南。
- `docs/cloud-deployment.md`：云端部署示例（Caddy + Docker Compose）。
- `docs/project-intro.md`：项目中文介绍概要。

如需贡献新平台/AI/命令，建议先阅读 `docs/architecture.md` 中对应章节，再提交 PR。欢迎在 Issues 区反馈中文使用体验。祝开发顺利！
