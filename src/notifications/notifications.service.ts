import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Expo Push Notification message structure.
 * Defines the payload format required by the Expo Push API.
 *
 * @interface ExpoPushMessage
 * @see https://docs.expo.dev/push-notifications/sending-notifications/
 */
// Expo Push Notification types
interface ExpoPushMessage {
  to: string;
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
}

interface ExpoPushTicket {
  id?: string;
  status: 'ok' | 'error';
  message?: string;
  details?: {
    error?: string;
  };
}

/**
 * Represents a pending Claude approval request being tracked by the service.
 * Contains all information needed to manage the approval lifecycle and
 * deliver the response back to the correct Claude CLI session.
 *
 * @interface PendingApproval
 * @property {string} approvalId - Unique identifier for this approval request
 * @property {string} userId - User ID who owns the terminal session
 * @property {string} terminalSessionId - The terminal session awaiting approval
 * @property {string} [sessionKey] - Optional Claude session key for session identification
 * @property {string[]} context - Recent output lines providing context for the approval
 * @property {string[]} options - Available response options in "key:label" format
 * @property {string} promptText - The approval prompt text from Claude CLI
 * @property {number} createdAt - Unix timestamp (ms) when the approval was created
 * @property {NodeJS.Timeout} timeoutId - Reference to the auto-timeout handler
 */
// Pending approval tracking
interface PendingApproval {
  approvalId: string;
  userId: string;
  terminalSessionId: string;
  sessionKey?: string;
  context: string[];
  options: string[];
  promptText: string;
  createdAt: number;
  timeoutId: NodeJS.Timeout;
}

/**
 * Service for managing push notifications and Claude approval requests.
 *
 * Provides functionality for:
 * - Registering and managing Expo push notification tokens
 * - Sending push notifications via Expo Push API
 * - Tracking and managing Claude CLI approval requests
 * - Handling approval timeouts and responses
 *
 * @class NotificationsService
 * @injectable
 */
@Injectable()
export class NotificationsService {
  /** Logger instance for this service */
  private readonly logger = new Logger(NotificationsService.name);

  /** Expo Push API endpoint URL */
  private readonly EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

  /** Timeout duration for approval requests (5 minutes) */
  private readonly APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** Map of pending approval requests keyed by approvalId */
  private pendingApprovals = new Map<string, PendingApproval>();

  /**
   * Creates an instance of NotificationsService.
   *
   * @param {PrismaService} prisma - Database service for token persistence
   * @param {ConfigService} configService - Configuration service for app settings
   */
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  /**
   * Registers a push notification token for a user.
   *
   * Creates or updates the push token record in the database. Uses upsert
   * to handle both new registrations and token refreshes gracefully.
   *
   * @param {string} userId - The unique identifier of the user
   * @param {string} token - The Expo push notification token (ExponentPushToken[...])
   * @param {string} platform - The device platform ('ios' | 'android')
   * @returns {Promise<void>}
   * @throws {Error} If database operation fails
   */
  async registerToken(
    userId: string,
    token: string,
    platform: string,
  ): Promise<void> {
    try {
      await this.prisma.pushToken.upsert({
        where: {
          userId_token: {
            userId,
            token,
          },
        },
        update: {
          platform,
          updatedAt: new Date(),
        },
        create: {
          userId,
          token,
          platform,
        },
      });
      this.logger.log(`Registered push token for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to register push token for user ${userId}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /**
   * Unregisters a push notification token for a user.
   *
   * Removes the specified token from the database. Should be called when
   * a user logs out or when a device is no longer in use.
   *
   * @param {string} userId - The unique identifier of the user
   * @param {string} token - The push token to remove
   * @returns {Promise<void>}
   * @throws {Error} If database operation fails
   */
  async unregisterToken(userId: string, token: string): Promise<void> {
    try {
      await this.prisma.pushToken.deleteMany({
        where: {
          userId,
          token,
        },
      });
      this.logger.log(`Unregistered push token for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to unregister push token for user ${userId}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  /**
   * Retrieves all registered push tokens for a user.
   *
   * Returns an array of Expo push tokens that can be used to send
   * notifications to all of the user's devices.
   *
   * @param {string} userId - The unique identifier of the user
   * @returns {Promise<string[]>} Array of push token strings
   * @throws {Error} If database operation fails
   */
  async getUserTokens(userId: string): Promise<string[]> {
    try {
      const tokens = await this.prisma.pushToken.findMany({
        where: { userId },
        select: { token: true },
      });
      return tokens.map((t) => t.token);
    } catch (error) {
      this.logger.error(`Failed to get push tokens for user ${userId}: ${error instanceof Error ? error.message : error}`);
      return []; // Return empty array to allow graceful degradation
    }
  }

  /**
   * Sends a push notification to all devices registered to a user.
   *
   * Retrieves all push tokens for the user and sends the notification
   * to each device via the Expo Push API.
   *
   * @param {string} userId - The unique identifier of the user
   * @param {string} title - The notification title
   * @param {string} body - The notification body text
   * @param {Record<string, any>} [data] - Optional custom data payload
   * @returns {Promise<void>}
   */
  async sendPushToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const tokens = await this.getUserTokens(userId);
    if (tokens.length === 0) {
      this.logger.warn(`No push tokens found for user ${userId}`);
      return;
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
    }));

    await this.sendExpoPushNotifications(messages);
  }

  /**
   * Sends push notifications via the Expo Push API.
   *
   * Makes a POST request to the Expo Push API with the provided messages.
   * Handles errors by logging failed deliveries and automatically removing
   * invalid/expired tokens from the database.
   *
   * @param {ExpoPushMessage[]} messages - Array of push messages to send
   * @returns {Promise<void>}
   * @private
   */
  private async sendExpoPushNotifications(
    messages: ExpoPushMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;

    let response: Response;
    try {
      response = await fetch(this.EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });
    } catch (error) {
      // Network error (DNS, connection refused, timeout, etc.)
      this.logger.error(`Network error sending push notifications: ${error instanceof Error ? error.message : error}`);
      return;
    }

    // Check for HTTP errors
    if (!response.ok) {
      this.logger.error(`Expo Push API returned HTTP ${response.status}: ${response.statusText}`);
      return;
    }

    let result: { data?: ExpoPushTicket[] };
    try {
      result = await response.json() as { data?: ExpoPushTicket[] };
    } catch (error) {
      this.logger.error(`Failed to parse Expo Push API response: ${error instanceof Error ? error.message : error}`);
      return;
    }

    const tickets: ExpoPushTicket[] = result.data || [];

    // Log any errors
    tickets.forEach((ticket, index) => {
      if (ticket.status === 'error') {
        this.logger.error(
          `Push notification failed for ${messages[index].to}: ${ticket.message}`,
        );
        // Handle invalid tokens (remove them)
        if (ticket.details?.error === 'DeviceNotRegistered') {
          this.handleInvalidToken(messages[index].to).catch((err) => {
            this.logger.error(`Failed to remove invalid token: ${err instanceof Error ? err.message : err}`);
          });
        }
      }
    });

    this.logger.log(`Sent ${tickets.filter((t) => t.status === 'ok').length} push notifications`);
  }

  /**
   * Handles an invalid push token by removing it from the database.
   *
   * Called when the Expo Push API returns a 'DeviceNotRegistered' error,
   * indicating the token is no longer valid (user uninstalled app, etc.).
   *
   * @param {string} token - The invalid token to remove
   * @returns {Promise<void>}
   * @private
   */
  private async handleInvalidToken(token: string): Promise<void> {
    try {
      await this.prisma.pushToken.deleteMany({
        where: { token },
      });
      this.logger.log(`Removed invalid push token: ${token}`);
    } catch (error) {
      this.logger.error(`Failed to remove invalid push token ${token}: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Tracks a pending Claude approval request.
   *
   * Stores the approval request details and sets up an automatic timeout
   * that will invoke the callback if no response is received within
   * APPROVAL_TIMEOUT_MS (5 minutes).
   *
   * If an approval with the same ID already exists, it clears the old
   * timeout and replaces it with the new one.
   *
   * @param {string} approvalId - Unique identifier for this approval request
   * @param {string} userId - The user ID who owns the terminal session
   * @param {Object} data - Approval request details
   * @param {string} data.terminalSessionId - The terminal session awaiting approval
   * @param {string} [data.sessionKey] - Optional Claude session key
   * @param {string[]} data.context - Recent output lines for context
   * @param {string[]} data.options - Available response options
   * @param {string} data.promptText - The approval prompt text
   * @param {(approvalId: string) => void} onTimeout - Callback invoked on timeout
   */
  trackPendingApproval(
    approvalId: string,
    userId: string,
    data: {
      terminalSessionId: string;
      sessionKey?: string;
      context: string[];
      options: string[];
      promptText: string;
    },
    onTimeout: (approvalId: string) => void,
  ): void {
    // Clear any existing timeout for this approval
    const existing = this.pendingApprovals.get(approvalId);
    if (existing) {
      clearTimeout(existing.timeoutId);
    }

    // Set up new timeout
    const timeoutId = setTimeout(() => {
      this.logger.log(`Approval ${approvalId} timed out`);
      this.pendingApprovals.delete(approvalId);
      onTimeout(approvalId);
    }, this.APPROVAL_TIMEOUT_MS);

    this.pendingApprovals.set(approvalId, {
      approvalId,
      userId,
      ...data,
      createdAt: Date.now(),
      timeoutId,
    });
  }

  /**
   * Retrieves a pending approval request by its ID.
   *
   * @param {string} approvalId - The unique identifier of the approval
   * @returns {PendingApproval | undefined} The pending approval if found, undefined otherwise
   */
  getPendingApproval(approvalId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  /**
   * Completes a pending approval request (either approved or denied).
   *
   * Removes the approval from the pending map and clears its timeout.
   * Returns the approval data so the caller can process the response.
   *
   * @param {string} approvalId - The unique identifier of the approval to complete
   * @returns {PendingApproval | undefined} The completed approval data, or undefined if not found
   */
  completePendingApproval(approvalId: string): PendingApproval | undefined {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingApprovals.delete(approvalId);
    }
    return pending;
  }

  /**
   * Sends a Claude approval notification to a user's devices.
   *
   * Creates a push notification with the approval prompt preview and
   * includes all necessary data for the mobile app to display the
   * approval dialog and send a response.
   *
   * The notification payload includes:
   * - type: 'claude_approval' (for routing in the mobile app)
   * - approvalId, sessionKey, terminalSessionId, options
   *
   * @param {string} userId - The user ID to send the notification to
   * @param {string} approvalId - Unique identifier for this approval request
   * @param {Object} data - Approval request details
   * @param {string} data.terminalSessionId - The terminal session awaiting approval
   * @param {string} [data.sessionKey] - Optional Claude session key
   * @param {string[]} data.context - Recent output lines for context
   * @param {string[]} data.options - Available response options in "key:label" format
   * @param {string} data.promptText - The approval prompt text (truncated to 100 chars)
   * @returns {Promise<void>}
   */
  async sendApprovalNotification(
    userId: string,
    approvalId: string,
    data: {
      terminalSessionId: string;
      sessionKey?: string;
      context: string[];
      options: string[];
      promptText: string;
    },
  ): Promise<void> {
    // Parse options to get human-readable labels
    const optionLabels = data.options
      .map((opt) => {
        const [key, label] = opt.split(':');
        return label || key;
      })
      .join(' / ');

    // Create notification body from prompt text (truncate if too long)
    const promptPreview = data.promptText.length > 100
      ? data.promptText.substring(0, 100) + '...'
      : data.promptText;

    await this.sendPushToUser(
      userId,
      'Claude Needs Approval',
      promptPreview,
      {
        type: 'claude_approval',
        approvalId,
        sessionKey: data.sessionKey,
        terminalSessionId: data.terminalSessionId,
        options: data.options,
      },
    );
  }
}
