import express from "express";
import multer from "multer";
import fs from "fs/promises";
import fsn from "fs";
import path from "path";
import rateLimit from "express-rate-limit";
import compression from "compression";
import helmet from "helmet";
import { whatsappClient } from "./services/whatsapp/client.js";
import { messageHandler } from "./services/whatsapp/messageHandler.js";
import wwebjs from "whatsapp-web.js";
import { connectDB, closeDB } from "./config/database.js";
import { logger } from "./utils/logger.js";
import { env } from "./config/env.js";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const { MessageMedia } = wwebjs;

app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "10kb" }));
app.use(express.static("public", { maxAge: "1d" }));

const apiLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"],
  handler: (req, res) => {
    res
      .status(429)
      .json({ error: "Too many requests, please try again later." });
  },
});

const validateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== env.API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  next();
};

app.use(apiLimiter);

// Set up file upload handling
const upload = multer({ dest: path.join(process.cwd(), "uploads/") });

app.post(
  "/api/send-zip",
  [validateApiKey, upload.single("file")],
  async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "ZIP file is required" });
      }

      const filePath = req.file.path;
      logger.info("Received ZIP file for sending", { phoneNumber, filePath });

      if (!whatsappClient.isAuthenticated) {
        return res
          .status(500)
          .json({ error: "WhatsApp client is not authenticated" });
      }

      // Create MessageMedia instance from file
      const media = MessageMedia.fromFilePath(filePath);
      media.filename = req.file.originalname || "file.zip";
      media.mimetype = "application/zip";

      // Send file via WhatsApp using MessageMedia
      await whatsappClient.client.sendMessage(phoneNumber, media);

      logger.info("ZIP file sent successfully", { phoneNumber });

      await fs.unlink(filePath);

      res.json({ success: true, message: "ZIP file sent successfully" });
    } catch (error) {
      logger.error("Failed to send ZIP file:", error);
      res
        .status(500)
        .json({ error: "Failed to send ZIP file", details: error.message });
    }
  },
);
app.get("/", (req, res) => {
  res.sendFile(`${process.cwd()}/public/index.html`);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/api/auth/pair", [validateApiKey, apiLimiter], async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }

  if (whatsappClient.isAuthenticated) {
    return res.status(400).json({ error: "Already authenticated" });
  }

  try {
    const pairingCode = await whatsappClient.client.requestPairingCode(phone);
    res.json({
      success: true,
      message: "Pairing code generated successfully",
      code: pairingCode,
    });
  } catch (error) {
    logger.error("Failed to generate pairing code:", error);
    res.status(500).json({
      error: "Failed to generate pairing code",
      details: env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

app.use((err, req, res, next) => {
  logger.error("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Initialize services
async function initialize() {
  try {
    await connectDB();
    await whatsappClient.initialize();
    logger.debug("WhatsApp client initialized");

    messageHandler.setClient(whatsappClient.getClient());
    messageHandler.start();

    app.listen(env.PORT, () => {
      logger.debug(`Server is running on port ${env.PORT}`);
    });
  } catch (error) {
    logger.error("Initialization error:", error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.debug(`${signal} received. Starting graceful shutdown...`);

  try {
    await whatsappClient.shutdown();
    await closeDB();
    logger.debug("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

initialize();
