import type { AppConfig } from '../../app/config.ts';

export function createLogger(level: AppConfig['logLevel']) {
  const ranks = { error: 0, warn: 1, info: 2, debug: 3 };
  return (severity: AppConfig['logLevel'], event: string, fields: { tool?: string; durationMs?: number; code?: string; count?: number } = {}) => {
    if (ranks[severity] <= ranks[level]) process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: severity, event, ...fields }) + '\n');
  };
}
