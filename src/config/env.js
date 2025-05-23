import { z } from "zod";
import { logger } from "../utils/logger.js";
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
  PROXY_URL: z.string(),
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
    const env = envSchema.parse(process.env);

    return {
      ...env,
      NODE_ENV: process.env.NODE_ENV || "production",
    };
  } catch (error) {
    logger.error(
      "Environment validation failed:",
      JSON.stringify(error.errors, null, 2),
    );

    process.exit(1);
  }
}

export const env = validateEnv();
