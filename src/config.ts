import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load environment variables from .local.env file
const localEnvPath = resolve(process.cwd(), '.local.env');
if (existsSync(localEnvPath)) {
  config({ path: localEnvPath });
}

// Fallback to default environment variables if not set in .local.env
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const OTEL_ENDPOINT = process.env.OTEL_ENDPOINT || 'http://localhost:4318';

// Debug configuration
export const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
export const LOG_LEVEL = process.env.LOG_LEVEL || (DEBUG ? 'debug' : 'info');
