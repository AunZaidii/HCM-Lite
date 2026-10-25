import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional().or(z.literal('')).default(''),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  ADMIN_EMAIL: z.string().optional().default(''),
  ADMIN_PASSWORD: z.string().optional().default(''),
  AI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta/openai/'),
  AI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  AI_FALLBACK_MODEL: z.string().optional().default('gemini-3.1-flash-lite'),
  AI_REASONING_EFFORT: z.string().optional().default('low'),
  AI_API_KEY: z.string().optional().default(''),
  AI_TIMEOUT_MS: z.coerce.number().default(15000),
  AI_RATE_LIMIT_PER_HOUR: z.coerce.number().default(20),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
