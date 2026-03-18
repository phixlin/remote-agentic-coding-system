/**
 * Remote Coding Agent - Main Entry Point
 * Telegram + Claude MVP
 */

// Load environment variables FIRST, before any other imports
import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { TelegramAdapter } from './adapters/telegram';
import { TestAdapter } from './adapters/test';
import { GitHubAdapter } from './adapters/github';
import { FeishuAdapter } from './adapters/feishu';
import { handleMessage } from './orchestrator/orchestrator';
import { pool } from './db/connection';
import { ConversationLockManager } from './utils/conversation-lock';

async function main(): Promise<void> {
  console.log('[App] Starting Remote Coding Agent (Telegram + Claude MVP)');

  // Validate required environment variables
  const required = ['DATABASE_URL'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('[App] Missing required environment variables:', missing.join(', '));
    console.error('[App] Please check .env.example for required configuration');
    process.exit(1);
  }

  const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const feishuUseLongConnection = process.env.FEISHU_USE_LONG_CONNECTION !== 'false';
  const hasFeishu =
    Boolean(process.env.FEISHU_APP_ID) &&
    Boolean(process.env.FEISHU_APP_SECRET) &&
    (feishuUseLongConnection || Boolean(process.env.FEISHU_VERIFICATION_TOKEN));
  const hasGitHub = Boolean(process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET);
  if (!hasTelegram && !hasFeishu && !hasGitHub) {
    console.error(
      '[App] No platform adapters configured. Set Telegram, Feishu, or GitHub credentials.'
    );
    process.exit(1);
  }

  // Validate AI assistant credentials (warn if missing, don't fail)
  const hasClaudeCredentials = process.env.CLAUDE_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasCodexCredentials = process.env.CODEX_ID_TOKEN && process.env.CODEX_ACCESS_TOKEN;

  if (!hasClaudeCredentials && !hasCodexCredentials) {
    console.error('[App] No AI assistant credentials found. Set Claude or Codex credentials.');
    process.exit(1);
  }

  if (!hasClaudeCredentials) {
    console.warn('[App] Claude credentials not found. Claude assistant will be unavailable.');
  }
  if (!hasCodexCredentials) {
    console.warn('[App] Codex credentials not found. Codex assistant will be unavailable.');
  }

  // Test database connection
  try {
    await pool.query('SELECT 1');
    console.log('[Database] Connected successfully');
  } catch (error) {
    console.error('[Database] Connection failed:', error);
    process.exit(1);
  }

  // Initialize conversation lock manager
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_CONVERSATIONS || '10');
  const lockManager = new ConversationLockManager(maxConcurrent);
  console.log(`[App] Lock manager initialized (max concurrent: ${maxConcurrent})`);

  // Initialize test adapter
  const testAdapter = new TestAdapter();
  await testAdapter.start();

  // Initialize GitHub adapter (conditional)
  let github: GitHubAdapter | null = null;
  if (process.env.GITHUB_TOKEN && process.env.WEBHOOK_SECRET) {
    github = new GitHubAdapter(process.env.GITHUB_TOKEN, process.env.WEBHOOK_SECRET);
    await github.start();
  } else {
    console.log('[GitHub] Adapter not initialized (missing GITHUB_TOKEN or WEBHOOK_SECRET)');
  }

  // Initialize Feishu adapter (conditional)
  let feishu: FeishuAdapter | null = null;
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    feishu = new FeishuAdapter({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      streamingMode: (process.env.FEISHU_STREAMING_MODE as 'stream' | 'batch') || 'stream',
      botOpenId: process.env.FEISHU_BOT_OPEN_ID,
      requireGroupMention: process.env.FEISHU_REQUIRE_GROUP_MENTION === 'false' ? false : true,
      useLongConnection: feishuUseLongConnection,
      lockManager,
    });
    await feishu.start();
  } else {
    console.log(
      '[Feishu] Adapter not initialized (missing FEISHU_APP_ID or FEISHU_APP_SECRET)'
    );
  }

  // Setup Express server
  const app = express();
  const port = process.env.PORT || 3000;

  // GitHub webhook endpoint (must use raw body for signature verification)
  // IMPORTANT: Register BEFORE express.json() to prevent body parsing
  if (github) {
    app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
      try {
        const signature = req.headers['x-hub-signature-256'] as string;
        if (!signature) {
          return res.status(400).json({ error: 'Missing signature header' });
        }

        const payload = (req.body as Buffer).toString('utf-8');

        // Process async (fire-and-forget for fast webhook response)
        github.handleWebhook(payload, signature).catch(error => {
          console.error('[GitHub] Webhook processing error:', error);
        });

        return res.status(200).send('OK');
      } catch (error) {
        console.error('[GitHub] Webhook endpoint error:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }
    });
    console.log('[Express] GitHub webhook endpoint registered');
  }

  // JSON parsing for all other endpoints
  app.use(express.json());

  if (feishu?.isWebhookEnabled()) {
    app.post('/webhooks/feishu', async (req, res) => {
      try {
        const result = await feishu!.handleWebhook(req.body);
        if (result.challenge) {
          return res.status(200).json({ challenge: result.challenge });
        }
        return res.status(200).json({ code: 0, msg: 'success' });
      } catch (error) {
        console.error('[Feishu] Webhook endpoint error:', error);
        return res.status(400).json({ code: 1, msg: 'invalid request' });
      }
    });
    console.log('[Express] Feishu webhook endpoint registered');
  }

  // Health check endpoints
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/db', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'connected' });
    } catch (_error) {
      res.status(500).json({ status: 'error', database: 'disconnected' });
    }
  });

  app.get('/health/concurrency', (_req, res) => {
    try {
      const stats = lockManager.getStats();
      res.json({
        status: 'ok',
        ...stats
      });
    } catch (_error) {
      res.status(500).json({ status: 'error', reason: 'Failed to get stats' });
    }
  });

  // Test adapter endpoints
  app.post('/test/message', async (req, res) => {
    try {
      const { conversationId, message } = req.body;
      if (!conversationId || !message) {
        return res.status(400).json({ error: 'conversationId and message required' });
      }

      await testAdapter.receiveMessage(conversationId, message);

      // Process the message through orchestrator (non-blocking)
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(testAdapter, conversationId, message);
        })
        .catch(error => {
          console.error('[Test] Message handling error:', error);
        });

      return res.json({ success: true, conversationId, message });
    } catch (error) {
      console.error('[Test] Endpoint error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/test/messages/:conversationId', (req, res) => {
    const messages = testAdapter.getSentMessages(req.params.conversationId);
    res.json({ conversationId: req.params.conversationId, messages });
  });

  app.delete('/test/messages/:conversationId?', (req, res) => {
    testAdapter.clearMessages(req.params.conversationId);
    res.json({ success: true });
  });

  app.listen(port, () => {
    console.log(`[Express] Health check server listening on port ${port}`);
  });

  // Initialize platform adapter (Telegram)
  let telegram: TelegramAdapter | null = null;

  if (hasTelegram) {
    const streamingMode = (process.env.TELEGRAM_STREAMING_MODE || 'stream') as 'stream' | 'batch';
    telegram = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN!, streamingMode);

    // Handle text messages
    telegram.getBot().on('text', async ctx => {
      const conversationId = telegram!.getConversationId(ctx);
      const message = ctx.message.text;

      if (!message) return;

      // Fire-and-forget: handler returns immediately, processing happens async
      lockManager
        .acquireLock(conversationId, async () => {
          await handleMessage(telegram!, conversationId, message);
        })
        .catch(error => {
          console.error('[Telegram] Failed to process message:', error);
        });
    });

    // Start bot
    await telegram.start();
    console.log('[App] Telegram bot ready');
  } else {
    console.log('[Telegram] Adapter not initialized (missing TELEGRAM_BOT_TOKEN)');
  }

  // Graceful shutdown
  const shutdown = (): void => {
    console.log('[App] Shutting down gracefully...');
    telegram?.stop();
    pool.end().then(() => {
      console.log('[Database] Connection pool closed');
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.log('[App] Remote Coding Agent is ready!');
  if (telegram) {
    console.log('[App] Send messages to your Telegram bot to get started');
  }
  console.log('[App] Test endpoint available: POST http://localhost:' + port + '/test/message');
}

// Run the application
main().catch(error => {
  console.error('[App] Fatal error:', error);
  process.exit(1);
});
