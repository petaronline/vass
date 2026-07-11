/**
 * Environment configuration with validation.
 *
 * If any required env var is missing or malformed, the app refuses to start.
 * Better to fail at boot than to crash mid-request with a confusing error.
 */
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis (will be used in Phase 3 for the queue, but we configure it now)
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Sessions — must be at least 32 chars of randomness
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  // Meta — optional for Phase 0, required from Phase 1 onward
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_SYSTEM_USER_TOKEN: z.string().optional(),
  META_BUSINESS_ID: z.string().optional(),

  // URLs
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
