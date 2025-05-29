import { z } from "zod";
// Import logger, but we'll be cautious using it during this file's immediate execution.
import { logger as mainLogger } from "../utils/logger.js";
import dotenv from "dotenv";
dotenv.config();

const envSchema = z.object({
  SESSION_DATA_PATH: z.string().default("./sessions"),
  ADMIN: z
    .string()
    .transform((val) => val.split(",").map((num) => num.trim()))
    .default(""),

  GEMINI_API_KEY: z.string(),
  HF_TOKEN: z.string(),
  // If PROXY_URL is optional, modify its schema accordingly:
  // PROXY_URL: z.string().optional(),
  // or with a default if it should always have a string value:
  // PROXY_URL: z.string().default(""),
  // For this example, I'll assume it might be optional or you'll ensure it's in your .env
  PROXY_URL: z.string().optional(), // Changed to optional as an example. Adjust if it's truly required.
  API_KEY: z.string().min(32, "API key must be at least 32 characters"),

  MONGODB_URI: z.string().url("Invalid MongoDB URI"),

  PORT: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .default("3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  RATE_LIMIT_WINDOW_MS: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .default("900000"),
  RATE_LIMIT_MAX_REQUESTS: z
    .string()
    .transform((val) => Number.parseInt(val, 10))
    .default("100"),

  WEBHOOK_URLS: z
    .string()
    .transform((val) => val.split(",").map((url) => url.trim()))
    .default(""),
});

function validateEnv() {
  try {
    const parsedEnv = envSchema.parse(process.env);

    // The original logic for NODE_ENV specifically overrides Zod's default ('development')
    // to 'production' if process.env.NODE_ENV is not set. This is a common pattern.
    return {
      ...parsedEnv, // Use the parsed and validated environment variables
      NODE_ENV: process.env.NODE_ENV || "production",
    };
  } catch (error) {
    // Fallback to console.error for this critical early error,
    // as mainLogger might not be initialized yet.
    console.error("❌ Critical Error: Environment variable validation failed!");
    console.error("📜 Details:", JSON.stringify(error.errors, null, 2));
    console.error(
      "🚨 Application cannot start. Please check your .env file or environment variables.",
    );

    // Optionally, attempt to use the main logger if it's available, but don't depend on it here.
    try {
      if (mainLogger && typeof mainLogger.error === "function") {
        mainLogger.error(
          "Environment validation failed (also logged via mainLogger):",
          JSON.stringify(error.errors, null, 2),
        );
      }
    } catch (loggerAccessError) {
      // This catch is for the case where mainLogger itself is problematic to access.
      console.error(
        "⚠️ Additionally, the main application logger could not be accessed:",
        loggerAccessError.message,
      );
    }

    process.exit(1); // Exit the application as the environment is invalid.
  }
}

export const env = validateEnv();
