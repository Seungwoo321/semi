import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

const file = join(dataDir, 'branding.json');
export function botName() {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).name : null;
}
export function setBotName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 60 ||
    [...name].some((c) => c.charCodeAt(0) < 32)
  ) {
    throw new Error(
      'Bot name must be 1–60 characters without control characters.',
    );
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ name: name.trim() }), { mode: 0o600 });
}
