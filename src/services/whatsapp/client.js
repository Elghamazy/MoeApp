import WhatsAppWeb from "whatsapp-web.js";
import puppeteer from "puppeteer";
import { logger } from "../../utils/logger.js";
import { Commands, StoryTracking } from "../../config/database.js";
import { env } from "../../config/env.js";
import { messageHandler } from "./messageHandler.js";

const { Client, LocalAuth } = WhatsAppWeb;

// Constants
const CONFIG = {
  MAX_RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY: 5000,
  CLIENT_ID: "whatsapp-bot",
  PUPPET_ARGS: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
  ],
  DEFAULT_COMMANDS: [
    {
      name: "help",
      enabled: true,
      adminOnly: false,
      category: "general",
      description: "Displays a list of all available commands and their usage",
      usage: "!help [command]",
    },
    {
      name: "toggleai",
      enabled: true,
      adminOnly: true,
      category: "admin",
      description: "Toggles the AI response functionality on or off",
      usage: "!toggleai",
    },
    {
      name: "togglecmd",
      enabled: true,
      adminOnly: true,
      category: "admin",
      description: "Enables or disables a specified command",
      usage: "!togglecmd <command_name>",
    },
    {
      name: "track",
      enabled: true,
      adminOnly: false,
      category: "utility",
      description: "Track a user's stories and receive them in DMs",
      usage:
        "!track <@mention or number>\n!track list\n!track stop <@mention or number>",
    },
    {
      name: "pfp",
      enabled: true,
      adminOnly: false,
      category: "utility",
      description:
        "Retrieves the profile picture of a mentioned user or number",
      usage: "!pfp <@mention or number>",
    },
    {
      name: "logs",
      enabled: true,
      adminOnly: true,
      category: "admin",
      description: "Displays bot statistics and command usage information",
      usage: "!logs",
    },
    {
      name: "speak",
      enabled: true,
      adminOnly: false,
      category: "media",
      description: "Converts a quoted text message into voice audio",
      usage: "!speak (quote a message)",
    },
    {
      name: "img",
      enabled: true,
      adminOnly: false,
      category: "media",
      description: "Searches and sends an image based on the given query",
      usage: "!img <search query>",
    },
    {
      name: "song",
      enabled: true,
      adminOnly: false,
      category: "media",
      description:
        "Downloads and sends a song with its information from a URL or search query",
      usage: "!song <URL/song title>",
    },
    {
      name: "redgifs",
      enabled: true,
      adminOnly: false,
      category: "media",
      description: "Generates and sends media content privately (max 20)",
      usage: "!redgifs <number (1-20)> <password>",
    },
    {
      name: "msg",
      enabled: true,
      adminOnly: true,
      category: "admin",
      description: "Sends a message to a specified user through the bot",
      usage: "!msg <@mention or number> <message>",
    },
    {
      name: "shutup",
      enabled: true,
      adminOnly: true,
      category: "admin",
      description:
        "Adds a user to the shutup list and replies to their messages with 'shut up <name>' or removes them from the list",
      usage:
        '!shutup <mention or phone number> "<name of the person>"\n!shutup remove <mention or phone number>',
    },
  ],
};

/**
 * WhatsApp client implementation with reconnection handling
 */
class WhatsAppClient {
  constructor() {
    this.client = null;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Initialize the WhatsApp client with proper configuration
   */
  async initialize() {
    try {
      const args = [...CONFIG.PUPPET_ARGS];
      if (env.PROXY_URL) {
        args.push(`--proxy-server=${env.PROXY_URL}`);
        logger.info(`Using proxy: ${env.PROXY_URL}`);
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: CONFIG.CLIENT_ID,
          dataPath: env.SESSION_DATA_PATH,
        }),
        puppeteer: {
          headless: true,
          executablePath: puppeteer.executablePath(),
          args,
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
      await this.initializeCommands();
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize WhatsApp client");
      throw error;
    }
  }

  /**
   * Get the initialized client instance
   * @returns {Client} WhatsApp client instance
   */
  getClient() {
    if (!this.client) {
      throw new Error("WhatsApp client is not initialized yet.");
    }
    return this.client;
  }

  /**
   * Set up all event handlers for the WhatsApp client
   */
  setupEventHandlers() {
    this.client.on("authenticated", () => this.handleAuthenticated());
    this.client.on("auth_failure", (error) => this.handleAuthFailure(error));
    this.client.on("disconnected", (reason) => this.handleDisconnected(reason));
    this.client.on("ready", () => this.handleReady());
    this.client.on("message", async (message) => {
      try {
        if (message.isStatus) {
          await this.handleStatusMessage(message);
        } else {
          await messageHandler.handleMessage(message);
        }
      } catch (error) {
        logger.error(
          { err: error, messageId: message.id },
          "Error processing message",
        );
      }
    });
  }

  /**
   * Handle successful authentication
   */
  handleAuthenticated() {
    logger.info("WhatsApp client authenticated");
    this.isAuthenticated = true;
  }

  /**
   * Handle authentication failure
   * @param {Error} error - The authentication error
   */
  handleAuthFailure(error) {
    logger.error({ err: error }, "WhatsApp authentication failed");
    this.isAuthenticated = false;
    this.handleReconnect();
  }

  /**
   * Handle client disconnection
   * @param {string} reason - The disconnection reason
   */
  handleDisconnected(reason) {
    logger.warn("WhatsApp client disconnected:", reason);
    this.isAuthenticated = false;
    this.handleReconnect();
  }

  /**
   * Handle client ready state
   */
  async handleReady() {
    this.isAuthenticated = true;
    this.reconnectAttempts = 0;
    await this.notifyAdmins("Bot is online and ready!");
  }

  /**
   * Handle reconnection logic
   */
  async handleReconnect() {
    if (this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      logger.error("Max reconnection attempts reached");
      process.exit(1);
    }

    this.reconnectAttempts++;
    logger.info(
      `Attempting to reconnect (${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})`,
    );

    setTimeout(async () => {
      try {
        await this.initialize();
      } catch (error) {
        logger.error({ err: error }, "Reconnection attempt failed");
        this.handleReconnect();
      }
    }, CONFIG.RECONNECT_DELAY);
  }

  /**
   * Send a notification to all admin users
   * @param {string} message - The message to send
   */
  async notifyAdmins(message) {
    const adminPhones = env.ADMIN || [];

    const sendResults = await Promise.allSettled(
      adminPhones.map(async (adminPhone) => {
        const chatId = `${adminPhone}@c.us`;
        await this.client.sendMessage(chatId, message);
        return adminPhone;
      }),
    );

    // Log successes and failures
    sendResults.forEach((result) => {
      if (result.status === "fulfilled") {
        logger.info(`Message sent to admin (${result.value})`);
      } else {
        logger.error({ err: result.reason }, `Error sending message to admin`);
      }
    });
  }

  /**
   * Process and forward status messages to trackers
   * @param {Message} message - The status message
   */
  async handleStatusMessage(message) {
    try {
      // Get the author's contact
      const contact = await message.getContact();
      const authorNumber = contact.id._serialized;

      // Find all active trackers for this number
      const trackers = await StoryTracking.find({
        targetNumber: authorNumber,
        active: true,
      });

      if (trackers.length === 0) return;

      // Process status content
      const { statusContent, media } = await this.processStatusContent(message);
      const timestamp = new Date(message.timestamp * 1000).toLocaleString();
      const caption = this.formatStatusCaption(
        contact.pushname,
        statusContent,
        timestamp,
      );

      // Send to all trackers
      await this.sendStatusToTrackers(trackers, caption, media);
    } catch (error) {
      logger.error({ err: error }, "Error handling status message");
    }
  }

  /**
   * Process status message content and media
   * @param {Message} message - The status message
   * @returns {Object} Processed content and media
   */
  async processStatusContent(message) {
    let statusContent;
    let media = null;

    if (message.hasMedia) {
      media = await message.downloadMedia();
      statusContent = message.body || "Posted a new status";
    } else {
      statusContent = message.body;
    }

    return { statusContent, media };
  }

  /**
   * Format caption for status messages
   * @param {string} pushname - Contact name
   * @param {string} statusContent - Status content
   * @param {string} timestamp - Formatted timestamp
   * @returns {string} Formatted caption
   */
  formatStatusCaption(pushname, statusContent, timestamp) {
    return `*New Status from ${pushname || "Unknown"}*\n\n${statusContent}\n\nPosted at: ${timestamp}`;
  }

  /**
   * Send status to all trackers
   * @param {Array} trackers - List of tracker documents
   * @param {string} caption - Formatted caption
   * @param {MessageMedia} media - Optional media content
   */
  async sendStatusToTrackers(trackers, caption, media) {
    const sendPromises = trackers.map(async (tracker) => {
      try {
        if (media) {
          await this.client.sendMessage(tracker.trackerNumber, media, {
            caption: caption,
          });
        } else {
          await this.client.sendMessage(tracker.trackerNumber, caption);
        }

        // Update last checked time
        await StoryTracking.updateOne(
          { _id: tracker._id },
          { $set: { lastChecked: new Date() } },
        );
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to forward status to ${tracker.trackerNumber}`,
        );
      }
    });

    await Promise.allSettled(sendPromises);
  }

  /**
   * Initialize default commands in the database
   */
  async initializeCommands() {
    const insertPromises = CONFIG.DEFAULT_COMMANDS.map((command) =>
      Commands.upsert(
        { name: command.name },
        {
          $set: {
            description: command.description,
            category: command.category,
            usage: command.usage,
            enabled: command.enabled,
            adminOnly: command.adminOnly,
          },
          $setOnInsert: {
            lastUsed: new Date(),
            usageCount: 0,
          },
        },
      ),
    );

    await Promise.all(insertPromises);
  }

  /**
   * Gracefully shut down the client
   */
  async shutdown() {
    try {
      if (this.client) {
        await this.client.destroy();
        logger.info("WhatsApp client destroyed");
      }
    } catch (error) {
      logger.error({ err: error }, "Error during WhatsApp client shutdown");
    }
  }
}

export const whatsappClient = new WhatsAppClient();
