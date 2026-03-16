# Remote Coding Agent 项目介绍

本项目（Dynamous Remote Coding Agent）是一个让 AI 编程助手（Claude Code、Codex 等）通过 Telegram、GitHub 等平台 **远程操控代码仓库** 的系统。它将「平台交互 → 指令解析 → AI 对话 → 代码工作区」串成一条可持续运行的流水线，为开发者在任何地点远程编程、评审或协作提供基础设施。

---

## 能力速览

- **多入口交互**：原生支持 Telegram Bot、GitHub Issue/PR 评论与 Feishu（飞书）机器人，可按需扩展到更多 IM/协作平台。
- **双 AI 引擎**：统一标准接口对接 Claude Code 与 Codex，支持根据仓库/会话动态切换。
- **会话持久化**：把平台会话、AI Session、代码仓库信息写入 PostgreSQL，容器重启后依旧保持上下文。
- **命令系统**：开发者可以在仓库的 `.claude/commands`、`.agents/commands` 等目录维护 Markdown 指令文件，再通过 `/command-invoke` 触发，方便形成项目级 SOP。
- **工作区管理**：集成 `/clone`、`/setcwd`、`/repos` 等基础命令，结合 `/status`、`/reset` 保障远程协作安全。
- **实时 / 批量输出**：Telegram 采用流式推送，GitHub 采用批量总结，兼顾实时性和评论区的可读性。

---

## 核心架构

```
平台适配器 (Telegram / GitHub / Test)  →  Orchestrator
                                            │
                                            ├─ Slash Command Handler（/clone、/commands、/command-invoke…）
                                            └─ AI Assistant Clients（ClaudeClient / CodexClient）
                                                     │
                                                     └─ 工作区（/workspace/<repo>）+ PostgreSQL（三张核心表）
```

### 主要模块

| 模块 | 说明 | 关键文件 |
| --- | --- | --- |
| 平台适配器 `IPlatformAdapter` | 把不同平台的消息统一转换为 `conversationId + message`，并负责回传消息、控制流式/批处理模式。 | `src/adapters/telegram.ts`, `src/adapters/github.ts`, `src/adapters/feishu.ts`, `src/adapters/test.ts` |
| Orchestrator | 项目的「大脑」，接入 Slash 命令、调用 AI 客户端、维持锁（防止同会话并发）、处理 plan → execute 的 session 迁移。 | `src/orchestrator/orchestrator.ts` |
| AI 客户端 `IAssistantClient` | 对接 Claude/Codex SDK，统一返回 `AsyncGenerator<MessageChunk>`，支持 session resume。 | `src/clients/claude.ts`, `src/clients/codex.ts`, `src/clients/factory.ts` |
| 命令系统 | `/clone`、`/command-set`、`/load-commands` 等命令确保基础操作可预测且可版本控制。 | `src/handlers/command-handler.ts` |
| 数据存储 | 三张表 `remote_agent_conversations`、`remote_agent_codebases`、`remote_agent_sessions` 分别记录平台信息、仓库信息、AI session。 | `migrations/001_initial_schema.sql`, `src/db/*.ts` |
| 并发锁 | `ConversationLockManager` 控制同一会话串行执行，避免 AI 会话互相抢占。 | `src/utils/conversation-lock.ts` |

---

## 运行流程概览

1. **平台入口**：用户在 Telegram 对话 / GitHub Issue 中输入消息（Slash 命令或自由文本）。
2. **Orchestrator 分流**：  
   - Slash 命令（例如 `/clone repo-url`）直接交给 Command Handler 执行。  
   - `/command-invoke plan "需求"` 则读取仓库里的 Markdown 模板、进行变量替换。  
   - 普通消息会被附带 Issue/PR 上下文（在 GitHub 新会话中）后交给 AI。
3. **AI 调用**：根据会话绑定的 assistant 类型走 Claude 或 Codex 客户端，携带工作目录 `cwd` 及历史 sessionId，使用异步生成器实时吐出回复 / 工具调用 / 新 sessionId。
4. **消息回传**：  
   - Telegram：实时逐条推送，并做 4096 字符切分。  
   - GitHub：聚合最后一条 AI 消息中的非「工具提示」文本，生成结构化评论。
5. **状态持久化**：Conversation、Codebase、Session 写入 PostgreSQL；plan → execute 触发新的 session，保证实现阶段 token 干净。

---

## 使用方式（常见场景）

- **本地开发**：按照 README 中的《Core Configuration》创建 `.env`，本机 `npm install && npm run dev`，或使用 `docker compose` 起 `app` + `postgres`。
- **云端常驻**：参考 `docs/cloud-deployment.md`，在 VPS 上以 `docker compose --profile with-db up -d` 方式运行，并结合 Caddy/Ngrok 暴露 GitHub Webhook。
- **GitHub 协作**：配置 `WEBHOOK_SECRET` 后，在仓库里创建 Issue/PR，@`remote-agent` 即可触发自动回复；首次调用 `/command-invoke` 会自动附带 Issue/PR 概要。
- **命令体系**：在仓库 `.claude/commands/plan-feature.md` 内维护模板 → `/load-commands .claude/commands` → `/command-invoke plan-feature "登录页优化"` → `/command-invoke execute`，中途若换仓库/目录，可用 `/setcwd`。

---

## 可扩展性速记

1. **加新平台**：实现 `IPlatformAdapter`（参考 Telegram/GitHub），并在 `src/index.ts` 根据环境变量挂载。
2. **接新助手**：实现 `IAssistantClient`、在 `clients/factory.ts` 注册，并在 README 描述凭证获取。
3. **扩展命令**：在 `command-handler.ts` 新增分支，或直接在仓库写 Markdown 指令后 `/command-set`/`/load-commands`。
4. **工作流自动化**：结合 GitHub adapter 中的自动克隆/命令加载逻辑，可以实现“带命令的样板仓库”→“远程代理”一键启用。

---

## 典型应用场景

- **远程下班后继续迭代**：开发者用 Telegram 给家中服务器上的代理单独发指令，让 AI 在目标仓库里写代码 / 跑测试。
- **GitHub 评论自动化**：团队成员在 PR 下 @remote-agent，用模板化命令要求 AI 生成实施计划或验证报告。
- **多助手实验平台**：同一个代码库可按目录/命令切换 Claude 或 Codex，方便比较两套工具链效果。
- **自定义命令中心**：把公司内部 SOP 写成 Markdown 命令，让远程代理严格按流程执行，保证输出一致性。

---

## 参考文档

- `README.md`：完整安装、命令行、问题排查指南。
- `docs/architecture.md`：模块设计、扩展说明、常见模式。
- `docs/cloud-deployment.md`：云端部署（Caddy + Docker Compose + PostgreSQL）。
- `migrations/001_initial_schema.sql`：PostgreSQL 表结构，便于自定义查询或集成 BI。

如需更深入的二次开发，请优先阅读 `docs/architecture.md` 中「Adding Platform Adapters」「Adding AI Assistants」章节，再结合 `src/index.ts` 的启动流程理解系统整体生命周期。
