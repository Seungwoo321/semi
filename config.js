import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));
export const profile = process.env.SEMI_PROFILE || 'personal';
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile))
  throw new Error('Invalid SEMI_PROFILE name.');
export const dataDir = join(root, '.local', 'profiles', profile);
const envFile = join(dataDir, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
else if (profile === 'personal' && existsSync(join(root, '.env')))
  process.loadEnvFile(join(root, '.env'));

export function installation(overrides = {}) {
  const savedFile = join(dataDir, 'installation.json');
  const saved = existsSync(savedFile)
    ? JSON.parse(readFileSync(savedFile, 'utf8'))
    : {};
  const appId = overrides.appId ?? saved.appId ?? process.env.SLACK_APP_ID;
  const teamId = overrides.teamId ?? saved.teamId ?? process.env.SLACK_TEAM_ID;
  const apps = ['apps.json', 'apps.dev.json'].flatMap((name) => {
    const file = join(root, '.slack', name);
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Object.values(data.apps ?? data).filter(
      (app) => app && typeof app === 'object' && app.app_id,
    );
  });
  const candidates = apps.filter(
    (app) =>
      (!appId || app.app_id === appId) && (!teamId || app.team_id === teamId),
  );
  const binding = candidates.length === 1 ? candidates[0] : {};
  const result = {
    appId: appId ?? binding.app_id,
    teamId: teamId ?? binding.team_id,
    ownerId:
      overrides.ownerId ??
      saved.ownerId ??
      process.env.REPORTER_OWNER_ID ??
      binding.user_id,
  };
  for (const [key, prefix] of [
    ['appId', 'A'],
    ['teamId', 'T'],
    ['ownerId', 'U'],
  ]) {
    if (!new RegExp(`^${prefix}[A-Z0-9]+$`).test(result[key] ?? '')) {
      throw new Error(
        `Missing installation setting: ${key}. See .env.example.`,
      );
    }
  }
  return result;
}

export const databasePath = join(dataDir, 'reporter.sqlite');
export const ownershipPath = join(root, '.local', 'session-owners.sqlite');
