# Remote Coding Agent 项目介绍 / Project Overview

本项目（Dynamous Remote Coding Agent）是一个让 AI 编程助手（Claude Code、Codex 等）通过 Telegram、GitHub、飞书等平台 **远程操控代码仓库** 的系统。它将「平台交互 → 指令解析 → AI 对话 → 代码工作区」串成一条可持续运行的流水线，为开发者在任何地点远程编程、评审或协作提供基础设施。

The Dynamous Remote Coding Agent lets AI coding assistants such as Claude Code and Codex operate repositories remotely through Telegram, GitHub, and Feishu. It stitches together platform interactions, slash commands, AI conversations, and a persistent workspace into a pipeline that keeps engineers productive from anywhere.

---

## 能力速览 / Capability Highlights

- **多入口交互**：原生支持 Telegram Bot、GitHub Issue/PR 评论与 Feishu（飞书）机器人，可按需扩展到更多 IM/协作平台。
- **双 AI 引擎**：统一接口对接 Claude Code 与 Codex，支持根据仓库/会话切换。
- **会话持久化**：平台会话、AI Session、代码仓库信息全部写入 PostgreSQL。
- **命令系统**：在 `.claude/commands`、`.agents/commands` 编写 Markdown 指令，通过 `/command-invoke` 执行 SOP。
- **工作区管理**：封装 `/clone`、`/setcwd`、`/repos`、`/status`、`/reset` 等命令，保障远程协作。
- **实时 / 批量输出**：Telegram 流式推送，GitHub 批量总结，Feishu 可配置 stream/batch。

- **Multi-channel access:** Native adapters for Telegram bots, GitHub issue/PR comments, and Feishu bots, with room for more IM platforms.
- **Two AI engines:** A shared interface talks to Claude Code and Codex so conversations can switch assistants per repository.
- **Persistent sessions:** PostgreSQL stores conversation metadata, AI sessions, and workspace info to survive container restarts.
- **Command system:** Markdown command files in `.claude/commands` or `.agents/commands` run via `/command-invoke`, enabling repeatable SOPs.
- **Workspace controls:** Built-in `/clone`, `/setcwd`, `/repos`, `/status`, and `/reset` commands make remote pair-programming predictable.
- **Streaming vs batch:** Telegram streams responses live, GitHub summarizes into a single comment, Feishu lets you choose the mode.

---

## 核心架构 / Core Architecture

```
平台适配器 (Telegram / GitHub / Feishu / Test)  →  Orchestrator
                                                  │
                                                  ├─ Slash Command Handler（/clone、/commands、/command-invoke…）
                                                  └─ AI Assistant Clients（ClaudeClient / CodexClient）
                                                           │
                                                           └─ 工作区（/workspace/<repo>）+ PostgreSQL（三张核心表）
```

```
Platform adapters (Telegram / GitHub / Feishu / Test) → Orchestrator
                                                       │
                                                       ├─ Slash Command Handler (/clone, /commands, /command-invoke…)
                                                       └─ AI Assistant Clients (ClaudeClient / CodexClient)
                                                                │
                                                                └─ Workspace (/workspace/<repo>) + PostgreSQL (3 tables)
```

### 主要模块 / Key Modules

| 模块 | 说明 | 关键文件 |
| --- | --- | --- |
| 平台适配器 `IPlatformAdapter` | 把不同平台的消息统一转换为 `conversationId + message`，并负责回传消息、控制流式/批处理模式。 | `src/adapters/telegram.ts`, `src/adapters/github.ts`, `src/adapters/feishu.ts`, `src/adapters/test.ts` |
| Orchestrator | 项目的「大脑」，接入 Slash 命令、调用 AI 客户端、维持锁、处理 plan → execute 的 session 迁移。 | `src/orchestrator/orchestrator.ts` |
| AI 客户端 `IAssistantClient` | 对接 Claude/Codex SDK，统一返回 `AsyncGenerator<MessageChunk>`，支持 session resume。 | `src/clients/claude.ts`, `src/clients/codex.ts`, `src/clients/factory.ts` |
| 命令系统 | `/clone`、`/command-set`、`/load-commands` 等命令确保基础操作可预测且可版本控制。 | `src/handlers/command-handler.ts` |
| 数据存储 | 三张表 `remote_agent_conversations`、`remote_agent_codebases`、`remote_agent_sessions` 分别记录平台、仓库、AI session 信息。 | `migrations/001_initial_schema.sql`, `src/db/*.ts` |
| 并发锁 | `ConversationLockManager` 控制同一会话串行执行，避免 AI 会话互相抢占。 | `src/utils/conversation-lock.ts` |

| Module | Description | Key Files |
| --- | --- | --- |
| Platform adapters (`IPlatformAdapter`) | Normalise inbound messages across platforms and control streaming/batch behaviour. | `src/adapters/telegram.ts`, `src/adapters/github.ts`, `src/adapters/feishu.ts`, `src/adapters/test.ts` |
| Orchestrator | The brain: routes slash commands, calls AI clients, enforces locks, and handles plan→execute session swaps. | `src/orchestrator/orchestrator.ts` |
| AI clients (`IAssistantClient`) | Wrap Claude/Codex SDKs, yielding `AsyncGenerator<MessageChunk>` with resume support. | `src/clients/claude.ts`, `src/clients/codex.ts`, `src/clients/factory.ts` |
| Command system | `/clone`, `/command-set`, `/load-commands`, etc. deliver deterministic, versioned workflows. | `src/handlers/command-handler.ts` |
| Data storage | `remote_agent_conversations`, `remote_agent_codebases`, `remote_agent_sessions` tables persist context. | `migrations/001_initial_schema.sql`, `src/db/*.ts` |
| Concurrency lock | `ConversationLockManager` ensures per-conversation serialization. | `src/utils/conversation-lock.ts` |

---

## 运行流程概览 / Flow Overview

1. **平台入口**：用户在 Telegram、GitHub、飞书输入命令或文本。
2. **Orchestrator 分流**：  
   - Slash 命令（如 `/clone`）直接由 Command Handler 处理；  
   - `/command-invoke ...` 会读取 Markdown 模板并替换变量；  
   - 普通消息（尤其 GitHub 首次）会附带 Issue/PR 上下文后交给 AI。
3. **AI 调用**：根据会话绑定的 assistant 类型调用 Claude/Codex 客户端，传入 `cwd` 与历史 sessionId，通过 async generator 获取回复、工具调用、新 sessionId。
4. **消息回传**：Telegram 流式逐条推送（自动切分 4096 字符），GitHub 汇总为一条评论，飞书遵循配置的 streaming/batch。
5. **状态持久化**：Conversation / Codebase / Session 写回 PostgreSQL，plan → execute 会重建 session 以保持上下文清晰。

1. **Entry point:** Users send slash commands or free text via Telegram chats, GitHub issues/PRs, or Feishu bots.
2. **Orchestrator routing:**  
   - Slash commands such as `/clone` run deterministically in the command handler.  
   - `/command-invoke` loads Markdown files from the repo and substitutes arguments.  
   - Plain text (especially the first GitHub comment) gets enriched with issue/PR context.
3. **AI execution:** The assigned assistant (Claude or Codex) receives the prompt, working directory, and optional session ID, streaming assistant/tool/result chunks back.
4. **Response delivery:** Telegram streams every chunk (auto-splitting >4096 chars), GitHub batches into a single cleaned comment, Feishu follows its configured streaming mode.
5. **Persistence:** Conversation, codebase, and session rows update in PostgreSQL; plan→execute forces a fresh session to keep implementation tokens lean.

---

## 使用方式（常见场景）/ Common Scenarios

- **本地开发**：根据 README 的 Core Configuration 配置 `.env`，运行 `npm run dev` 或 `docker compose`。
- **云端常驻**：参考 `docs/cloud-deployment.md` 在 VPS 上部署，配合 Caddy/Ngrok 暴露 Webhook。
- **GitHub 协作**：在 Issue/PR 中 @`remote-agent`，首条 `/command-invoke` 会附带 Issue/PR 引用。
- **命令体系**：在 `.claude/commands` 维护模板 → `/load-commands` → `/command-invoke plan-feature "需求"` → `/command-invoke execute`。

- **Local dev:** Follow the README’s core configuration, run `npm run dev` or use Docker profiles.
- **Cloud hosting:** Use `docs/cloud-deployment.md` to run on a VPS with Caddy/ngrok exposing webhooks.
- **GitHub workflows:** Mention `@remote-agent` in issues/PRs; the first `/command-invoke` auto-includes the issue/PR reference.
- **Command SOPs:** Store templates in `.claude/commands`, load them, then run `/command-invoke plan-feature "ask"` followed by `/command-invoke execute`.

---

## 可扩展性速记 / Extensibility Cheatsheet

1. **加新平台**：实现 `IPlatformAdapter`（参考 Telegram/GitHub/Feishu），在 `src/index.ts` 根据 env 挂载。
2. **接新助手**：实现 `IAssistantClient`、在 `clients/factory.ts` 注册并更新 README。
3. **扩展命令**：在 `command-handler.ts` 加命令或通过 Markdown + `/command-set` 管理。
4. **自动化流程**：用 GitHub adapter 的自动 clone/command-load 机制快速启用 SOP 仓库。

1. **Add a platform:** Implement `IPlatformAdapter`, wire it up in `src/index.ts`, and document the env vars.
2. **Add an assistant:** Build an `IAssistantClient`, register it in `clients/factory.ts`, and update README guidance.
3. **Extend commands:** Either add deterministic branches in `command-handler.ts` or manage Markdown files via `/command-set` and `/load-commands`.
4. **Workflow automation:** Combine GitHub auto-clone and command loading to ship repo templates that boot agents instantly.

---

## 典型应用场景 / Example Use Cases

- **远程续作**：下班后通过 Telegram/飞书向驻场服务器发指令，让 AI 继续开发或测试。
- **GitHub 评论自动化**：PR 下 @remote-agent，执行模板命令生成计划、分析或回归报告。
- **多助手对比**：同一仓库绑定不同命令走 Claude/Codex，便于评估效果。
- **企业 SOP 中心**：把规范写成 Markdown 命令，让代理严格执行。

- **Remote iteration:** Fire Telegram/Feishu commands at a server-side agent to continue coding overnight.
- **GitHub automation:** Mention `@remote-agent` on PRs to kick off templated plans, code reviews, or validation flows.
- **Assistant benchmarking:** Switch between Claude and Codex per repo or command to compare toolchains.
- **SOP execution:** Encode company runbooks as Markdown commands to guarantee consistent output.

---

## 参考文档 / References

- `README.md / README.zh-CN.md`：核心安装指南。
- `docs/architecture.md`：架构与扩展模式。
- `docs/cloud-deployment.md`：云端部署教程（Caddy + Docker Compose + PostgreSQL）。
- `migrations/001_initial_schema.sql`：数据库结构参考。

For deeper customization, start with `docs/architecture.md` (Adding Platform Adapters / Adding AI Assistants) and trace the bootstrap path in `src/index.ts`.愿你顺利构建自己的远程 AI 编程工作流。
