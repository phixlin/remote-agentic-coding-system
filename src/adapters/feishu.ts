/**
 * Feishu (Lark) platform adapter
 * Handles event callbacks from Feishu bots and sends messages via Open API
 */
import fetch from 'node-fetch';
import { IPlatformAdapter } from '../types';
import { handleMessage } from '../orchestrator/orchestrator';
import { ConversationLockManager } from '../utils/conversation-lock';

const TENANT_TOKEN_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_ENDPOINT = 'https://open.feishu.cn/open-apis/im/v1/messages';
const MAX_MESSAGE_LENGTH = 3500; // Leave headroom for JSON encoding + formatting

interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  streamingMode?: 'stream' | 'batch';
  lockManager: ConversationLockManager;
  botOpenId?: string;
  requireGroupMention?: boolean;
}

interface FeishuWebhookRequest {
  // Challenge payload
  type?: string;
  token?: string;
  challenge?: string;

  // Event payload
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
  };
  event?: {
    message: FeishuMessage;
    sender: {
      sender_id: {
        open_id: string;
        union_id?: string;
        user_id?: string;
      };
      sender_type: string;
    };
  };
  encrypt?: string;
}

interface FeishuMessage {
  chat_id: string;
  chat_type: 'group' | 'p2p';
  message_id: string;
  message_type: string;
  content: string;
  mentions?: Array<{
    key: string;
    name: string;
    open_id: string;
  }>;
}

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number;
}

interface FeishuMessageResponse {
  code: number;
  msg: string;
}

export class FeishuAdapter implements IPlatformAdapter {
  private streamingMode: 'stream' | 'batch';
  private tenantToken: string | null = null;
  private tokenExpiresAt = 0;
  private requireGroupMention: boolean;
  private botOpenId?: string;

  constructor(private config: FeishuAdapterConfig) {
    this.streamingMode = config.streamingMode || 'stream';
    this.requireGroupMention = config.requireGroupMention !== false;
    this.botOpenId = config.botOpenId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'feishu';
  }

  async start(): Promise<void> {
    console.log(`[Feishu] Adapter initialized (mode: ${this.streamingMode})`);
  }

  stop(): void {
    console.log('[Feishu] Adapter stopped');
  }

  /**
   * Handle webhook callback from Feishu
   */
  async handleWebhook(body: FeishuWebhookRequest): Promise<{ challenge?: string }> {
    // 1. URL verification challenge
    if (body.type === 'url_verification') {
      if (body.token !== this.config.verificationToken) {
        throw new Error('Invalid verification token');
      }
      console.log('[Feishu] URL verification completed');
      return { challenge: body.challenge };
    }

    // 2. Ignore encrypted payloads (not supported yet)
    if (body.encrypt) {
      throw new Error('Encrypted Feishu payloads are not supported. Disable encryption in bot settings.');
    }

    if (!body.header || !body.event) {
      console.log('[Feishu] Ignoring payload without header/event');
      return {};
    }

    if (body.header.token !== this.config.verificationToken) {
      throw new Error('Invalid verification token in header');
    }

    if (body.header.event_type !== 'im.message.receive_v1') {
      console.log(`[Feishu] Ignoring unsupported event type: ${body.header.event_type}`);
      return {};
    }

    void this.processMessageEvent(body.event).catch(error => {
      console.error('[Feishu] Failed to process message event:', error);
    });

    return {};
  }

  /**
   * Send a text message back to Feishu conversation
   */
  async sendMessage(conversationId: string, message: string): Promise<void> {
    const chunks = this.splitMessage(message);

    for (const chunk of chunks) {
      const token = await this.getTenantToken();
      const response = await fetch(`${MESSAGE_ENDPOINT}?receive_id_type=chat_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: conversationId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[Feishu] HTTP error sending message:', response.status, text);
        throw new Error(`Feishu message failed with status ${response.status}`);
      }

      const data = (await response.json()) as FeishuMessageResponse;
      if (data.code !== 0) {
        console.error('[Feishu] API error sending message:', data);
        throw new Error(`Feishu API error: ${data.msg}`);
      }
    }
  }

  /**
   * Parse and route incoming Feishu message to orchestrator
   */
  private async processMessageEvent(event: NonNullable<FeishuWebhookRequest['event']>): Promise<void> {
    const senderType = event.sender?.sender_type;
    if (senderType !== 'user') {
      console.log(`[Feishu] Ignoring sender type: ${senderType}`);
      return;
    }

    const message = event.message;
    const text = this.extractMessageText(message);
    if (!text) {
      console.log('[Feishu] No text content found in message');
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      console.log('[Feishu] Message empty after trimming');
      return;
    }

    const isGroup = message.chat_type === 'group';
    if (isGroup && this.requireGroupMention && !this.isBotMentioned(message)) {
      console.log('[Feishu] Skipping group message without bot mention');
      return;
    }

    const conversationId = message.chat_id;
    console.log(`[Feishu] Routing message for conversation ${conversationId}`);

    this.config.lockManager
      .acquireLock(conversationId, async () => {
        await handleMessage(this, conversationId, trimmed);
      })
      .catch(error => {
        console.error('[Feishu] Message handling error:', error);
      });
  }

  /**
   * Extract plain text from Feishu message payload
   */
  private extractMessageText(message: FeishuMessage): string | null {
    try {
      const content = JSON.parse(message.content);

      if (message.message_type === 'text') {
        const text: string = content.text || '';
        return this.stripMentions(text);
      }

      if (message.message_type === 'post') {
        const block = content.zh_cn || content.en_us || Object.values(content)[0];
        if (!block?.content) return null;

        const lines = block.content.map((row: Array<{ tag: string; text?: string; href?: string }>) =>
          row
            .map(node => {
              if (node.tag === 'text') {
                return node.text || '';
              }
              if (node.tag === 'a') {
                return `${node.text || ''} (${node.href || ''})`;
              }
              return '';
            })
            .join('')
        );
        return this.stripMentions(lines.join('\n'));
      }

      console.log(`[Feishu] Unsupported message type: ${message.message_type}`);
      return null;
    } catch (error) {
      console.error('[Feishu] Failed to parse message content:', error);
      return null;
    }
  }

  private stripMentions(text: string): string {
    return text.replace(/<at[^>]*>.*?<\/at>/g, '').trim();
  }

  private isBotMentioned(message: FeishuMessage): boolean {
    if (!message.mentions || message.mentions.length === 0) {
      return false;
    }

    if (this.botOpenId) {
      return message.mentions.some(mention => mention.open_id === this.botOpenId);
    }

    return true;
  }

  /**
   * Split long messages into Feishu-friendly chunks
   */
  private splitMessage(message: string): string[] {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      return [message];
    }

    const chunks: string[] = [];
    let buffer = '';

    for (const line of message.split('\n')) {
      if ((buffer + '\n' + line).trim().length > MAX_MESSAGE_LENGTH) {
        if (buffer) {
          chunks.push(buffer);
        }
        buffer = line;
      } else {
        buffer = buffer ? `${buffer}\n${line}` : line;
      }
    }

    if (buffer) {
      chunks.push(buffer);
    }
    return chunks;
  }

  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantToken && now < this.tokenExpiresAt - 60_000) {
      return this.tenantToken;
    }

    const response = await fetch(TENANT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch Feishu tenant token (${response.status}): ${text}`);
    }

    const data = (await response.json()) as TenantTokenResponse;
    if (data.code !== 0) {
      throw new Error(`Feishu token error: ${data.msg}`);
    }

    this.tenantToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + data.expire * 1000;
    return this.tenantToken;
  }
}
