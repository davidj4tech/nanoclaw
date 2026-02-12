import fs from 'fs';
import path from 'path';
import * as sdk from 'matrix-js-sdk';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';
  prefixAssistantName = true;

  private client!: sdk.MatrixClient;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private opts: MatrixChannelOpts;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const homeserver = process.env.MATRIX_HOMESERVER;
    const userId = process.env.MATRIX_USER_ID;
    const password = process.env.MATRIX_PASSWORD;

    if (!homeserver || !userId || !password) {
      throw new Error('Matrix credentials not configured. Set MATRIX_HOMESERVER, MATRIX_USER_ID, and MATRIX_PASSWORD in .env');
    }

    // Create session file path
    const sessionPath = path.join(STORE_DIR, 'matrix-session.json');

    // Try to load existing session
    let accessToken: string | undefined;
    let deviceId: string | undefined;

    if (fs.existsSync(sessionPath)) {
      try {
        const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        accessToken = session.access_token;
        deviceId = session.device_id;
        logger.debug('Loaded existing Matrix session');
      } catch (err) {
        logger.warn({ err }, 'Failed to load Matrix session, will re-login');
      }
    }

    // Create client
    this.client = sdk.createClient({
      baseUrl: homeserver,
      userId: userId,
      accessToken: accessToken,
      deviceId: deviceId,
    });

    // Login if we don't have a valid token
    if (!accessToken) {
      try {
        const loginResponse = await this.client.loginWithPassword(userId, password);

        // Save session
        fs.writeFileSync(sessionPath, JSON.stringify({
          access_token: loginResponse.access_token,
          device_id: loginResponse.device_id,
          user_id: loginResponse.user_id,
        }, null, 2));

        logger.info('Matrix login successful, session saved');

        // Recreate client with new credentials
        this.client = sdk.createClient({
          baseUrl: homeserver,
          userId: loginResponse.user_id,
          accessToken: loginResponse.access_token,
          deviceId: loginResponse.device_id,
        });
      } catch (err) {
        logger.error({ err }, 'Matrix login failed');
        throw new Error('Matrix login failed');
      }
    }

    // Set up event handlers
    this.client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === 'PREPARED') {
        this.connected = true;
        logger.info('Matrix client synced and ready');
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );
      }
    });

    // Auto-accept room invites
    this.client.on(sdk.RoomMemberEvent.Membership, async (event, member) => {
      if (member.membership === 'invite' && member.userId === this.client.getUserId()) {
        const roomId = member.roomId;
        logger.info({ roomId }, 'Received room invite, auto-joining');
        try {
          await this.client.joinRoom(roomId);
          logger.info({ roomId }, 'Successfully joined room');
        } catch (err) {
          logger.error({ roomId, err }, 'Failed to join room');
        }
      }
    });

    this.client.on(sdk.RoomEvent.Timeline, (event, room) => {
      const eventType = event.getType();

      // Handle both plain and encrypted messages
      if (eventType !== 'm.room.message' && eventType !== 'm.room.encrypted') return;
      if (event.getSender() === this.client.getUserId()) return; // Ignore own messages

      const roomId = room?.roomId;
      if (!roomId) return;

      // For encrypted messages, getContent() returns decrypted content after processing
      const content = event.getContent();

      // For encrypted messages, content might be under different keys during processing
      const msgtype = content.msgtype || content.type;
      const body = content.body || content.text;

      if (!body) return;

      const timestamp = new Date(event.getTs()).toISOString();
      const sender = event.getSender() || '';
      const senderName = room?.getMember(sender)?.name || sender;

      // Notify about chat metadata
      this.opts.onChatMetadata(roomId, timestamp);

      // Only deliver full message for registered groups
      const groups = this.opts.registeredGroups();

      if (groups[roomId]) {
        logger.info({ roomId, sender: senderName }, 'Message received');
        this.opts.onMessage(roomId, {
          id: event.getId() || '',
          chat_jid: roomId,
          sender,
          sender_name: senderName,
          content: body,
          timestamp,
          is_from_me: false,
        });
      } else {
        logger.warn({ roomId }, 'Message received from unregistered room');
      }
    });

    // Start syncing
    await this.client.startClient({ initialSyncLimit: 10 });

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      const checkSync = () => {
        if (this.connected) {
          resolve();
        } else {
          setTimeout(checkSync, 100);
        }
      };
      checkSync();
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, length: text.length, queueSize: this.outgoingQueue.length }, 'Matrix disconnected, message queued');
      return;
    }

    try {
      await this.client.sendTextMessage(jid, text);
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Matrix message, queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Matrix room IDs start with ! and end with :homeserver
    return jid.startsWith('!');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.client) {
      await this.client.stopClient();
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.client.sendTyping(jid, isTyping, 3000);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Matrix typing status');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing Matrix outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
