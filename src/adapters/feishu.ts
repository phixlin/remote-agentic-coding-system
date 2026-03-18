/**
 * Feishu (Lark) platform adapter
 * Uses Feishu SDK for long-connection event subscriptions by default
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { IPlatformAdapter } from '../types';
import { handleMessage } from '../orchestrator/orchestrator';
import { ConversationLockManager } from '../utils/conversation-lock';

const MAX_MESSAGE_LENGTH = 3500; // Leave headroom for JSON encoding + formatting

interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  streamingMode?: 'stream' | 'batch';
  lockManager: ConversationLockManager;
  botOpenId?: string;
  requireGroupMention?: boolean;
  useLongConnection?: boolean;
}

interface FeishuWebhookRequest {
  type?: string;
  token?: string;
  challenge?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
  };
  event?: FeishuEventPayload;
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

type FeishuEventPayload = {
  message: FeishuMessage;
  sender?: {
    sender_type: string;
    sender_id: {
      open_id: string;
      union_id?: string;
      user_id?: string;
    };
  };
};

export class FeishuAdapter implements IPlatformAdapter {
  private streamingMode: 'stream' | 'batch';
  private requireGroupMention: boolean;
  private botOpenId?: string;
  private useLongConnection: boolean;
  private webhookEnabled: boolean;
  private client: Lark.Client;
  private wsClient?: Lark.WSClient;
  private eventDispatcher?: Lark.EventDispatcher;

  constructor(private config: FeishuAdapterConfig) {
    this.streamingMode = config.streamingMode || 'stream';
    this.requireGroupMention = config.requireGroupMention !== false;
    this.botOpenId = config.botOpenId;
    this.useLongConnection = config.useLongConnection !== false;
    this.webhookEnabled = !this.useLongConnection && Boolean(config.verificationToken);
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'feishu';
  }

  async start(): Promise<void> {
    console.log(
      `[Feishu] Adapter initialized (mode: ${this.streamingMode}, long connection: ${this.useLongConnection})`
    );

    if (this.useLongConnection) {
      await this.startLongConnection();
    } else if (!this.webhookEnabled) {
      console.warn(
        '[Feishu] Webhook mode requested but FEISHU_VERIFICATION_TOKEN is missing. Adapter will not receive messages.'
      );
    }
  }

  stop(): void {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = undefined;
      console.log('[Feishu] Long connection closed');
    }
    console.log('[Feishu] Adapter stopped');
  }

  isWebhookEnabled(): boolean {
    return this.webhookEnabled;
  }

  private async startLongConnection(): Promise<void> {
    try {
      this.eventDispatcher = new Lark.EventDispatcher({
        loggerLevel: Lark.LoggerLevel.info,
      }).register({
        'im.message.receive_v1': async (event: Record<string, unknown>) => {
          await this.handleIncomingEvent(event as FeishuEventPayload);
        },
      });

      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        loggerLevel: Lark.LoggerLevel.info,
        autoReconnect: true,
      });

      await this.wsClient.start({
        eventDispatcher: this.eventDispatcher,
      });
      console.log('[Feishu] Long connection established');
    } catch (error) {
      console.error('[Feishu] Failed to start long connection:', error);
      throw error;
    }
  }

  /**
   * Handle webhook callback from Feishu (HTTP mode)
   */
  async handleWebhook(body: FeishuWebhookRequest): Promise<{ challenge?: string }> {
    if (!this.webhookEnabled) {
      throw new Error(
        'Feishu webhook mode disabled. Set FEISHU_USE_LONG_CONNECTION=false and provide FEISHU_VERIFICATION_TOKEN to enable callbacks.'
      );
    }

    if (body.type === 'url_verification') {
      if (body.token !== this.config.verificationToken) {
        throw new Error('Invalid verification token');
      }
      console.log('[Feishu] URL verification completed');
      return { challenge: body.challenge };
    }

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

    await this.handleIncomingEvent(body.event);
    return {};
  }

  /**
   * Send a message back to Feishu chat using SDK
   */
  async sendMessage(conversationId: string, message: string): Promise<void> {
    const chunks = this.splitMessage(message);

    for (const chunk of chunks) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: conversationId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
      } catch (error) {
        console.error('[Feishu] Failed to send message chunk:', error);
        throw error;
      }
    }
  }

  /**
   * Shared handler for both long-connection and webhook events
   */
  private async handleIncomingEvent(event: FeishuEventPayload): Promise<void> {
    try {
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
    } catch (error) {
      console.error('[Feishu] Failed to process incoming event:', error);
    }
  }

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
}
