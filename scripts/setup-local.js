import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

try {
  await writeFile(new URL('../.env', import.meta.url), [
    'PORT=5177', 'STORAGE_DRIVER=local',
    `ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}`,
    `SESSION_SECRET=${randomBytes(32).toString('base64url')}`,
    'OPENAI_API_KEY=', 'OPENAI_MODEL=gpt-6-luna',
    'ANTHROPIC_API_KEY=', 'ANTHROPIC_MODEL=', ''
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random local admin password and session secret. Existing API keys were not copied.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; left unchanged.');
  else throw error;
}
