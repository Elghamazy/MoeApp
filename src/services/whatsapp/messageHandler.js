// messageHandler.js
import { Commands, Settings } from "../../config/database.js";
import { logger } from "../../utils/logger.js";
import { commandHandlers } from "./commands/index.js";
import { handleMediaExtraction } from "../media/mediaExtractor.js";
import { generateAIResponse } from "../ai/aiService.js";
import { textToSpeech } from "../audio/tts.js";
import WhatsAppWeb from "whatsapp-web.js";
import { env } from "../../config/env.js";
import { whatsappClient } from "./client.js";
import removeMarkdown from "remove-markdown";

const { MessageMedia } = WhatsAppWeb;

const MESSAGE_LENGTH_THRESHOLD = 300;
const AUDIO_COMMANDS = new Set(["speak"]);
const activeUsers = new Set();
const chatSessions = new Map();

const ChatState = {
  async setTyping(chat) {
    try {
      await chat.sendStateTyping();
    } catch (error) {
      logger.error({ err: error }, "Failed to set typing state");
    }
  },

  async setRecording(chat) {
    try {
      await chat.sendStateRecording();
    } catch (error) {
      logger.error({ err: error }, "Failed to set recording state");
    }
  },

  async clear(chat) {
    try {
      await chat.clearState();
    } catch (error) {
      logger.error({ err: error }, "Failed to clear chat state");
    }
  },
};

async function shouldUseAI() {
  const setting = await Settings.findOne({ key: "ai_enabled" });
  return setting?.value ?? false;
}

async function generateVoiceIfNeeded(text, message) {
  try {
    const contact = await message.getContact();
    if (contact.name !== "Meta AI" && contact.pushname !== "Meta AI") return;

    const client = whatsappClient.getClient();
    const reloadedMessage = await waitForCompleteMessage(client, message.id._serialized);
    text = reloadedMessage.body;

    if (text.length >= MESSAGE_LENGTH_THRESHOLD) {
      const chat = await message.getChat();
      await chat.sendStateRecording();
      const { base64, mimeType } = await textToSpeech(text);
      const media = new MessageMedia(mimeType, base64);
      await message.reply(media, chat.id._serialized, { sendAudioAsVoice: true });
    }
  } catch (error) {
    logger.error({ err: error }, "Error generating voice for message");
  }
}

async function waitForCompleteMessage(client, messageId, maxAttempts = 10) {
  let previousMessage = "";
  let attempt = 0;

  while (attempt < maxAttempts) {
    const currentMessage = await client.getMessageById(messageId);
    const currentContent = currentMessage.body;

    if (currentContent === previousMessage) {
      return currentMessage;
    }

    previousMessage = currentContent;
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return await client.getMessageById(messageId);
}

function commandWillRespond(command, args, hasQuotedMsg) {
  switch (command) {
    case "help":
    case "toggleai":
    case "togglecmd":
    case "logs":
      return true;
    case "pfp":
      return args.length > 0 || hasQuotedMsg;
    case "speak":
      return hasQuotedMsg;
    case "img":
      return args.length > 0;
    case "msg":
      return args.length >= 2;
    default:
      return false;
  }
}

export class MessageHandler {
  constructor(processingInterval = 1000) {
    this.messageQueue = [];
    this.processingInterval = processingInterval;
  }

  async handleMessage(message) {
    if (message?.body) {
      this.messageQueue.push(message);
    }
  }

  async processMessage(message) {
    const chat = await message.getChat();
    try {
      if (message.body.startsWith("!")) {
        await this.handleCommand(message, chat);
        return;
      }

      const mediaResult = await handleMediaExtraction(message);
      if (mediaResult.processed) {
        await ChatState.clear(chat);
        return;
      }

      await generateVoiceIfNeeded(message.body, message);

      if (await shouldUseAI()) {
        await ChatState.setTyping(chat);
        await this.processAIMessage(message, chat);
      }

      await ChatState.clear(chat);
    } catch (error) {
      logger.error({ err: error }, "Error processing message");
      await message.reply("Sorry, there was an error processing your message.");
      await ChatState.clear(chat);
    }
  }

  async processAIMessage(message, chat) {
    const userMessage = message.body;
    const response = await generateAIResponse(userMessage);

    if (response.terminate) {
      activeUsers.delete(message.author || message.from);
      await chat.sendMessage("Alright, talk to you later!");
    } else {
      await chat.sendMessage(response.message);
    }
  }

  async handleCommand(message, chat) {
    const [command, ...args] = message.body.slice(1).split(" ");
    const commandKey = command.toLowerCase();

    try {
      const commandDoc = await Commands.findOne({ name: commandKey });

      if (!commandDoc?.enabled) {
        await message.reply(
          !commandDoc
            ? "Unknown command. Use !help to see available commands."
            : "This command is currently disabled."
        );
        return;
      }

      if (commandWillRespond(commandKey, args, message.hasQuotedMsg)) {
        const stateFn = AUDIO_COMMANDS.has(commandKey)
          ? ChatState.setRecording
          : ChatState.setTyping;
        await stateFn(chat);
      }

      const handler = commandHandlers[commandKey];
      if (handler) {
        await handler(message, args);
        await Commands.updateOne(
          { name: commandKey },
          { $inc: { usageCount: 1 }, $set: { lastUsed: new Date() } }
        );
      } else {
        await message.reply("This command is not implemented yet.");
      }
    } catch (error) {
      logger.error({ err: error }, "Error executing command");
      await message.reply("Error executing command. Please try again later.");
    } finally {
      await ChatState.clear(chat);
    }
  }

  async processQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      await this.processMessage(message);
    }
  }

  start() {
    setInterval(() => this.processQueue(), this.processingInterval);
  }
}

export const messageHandler = new MessageHandler();
