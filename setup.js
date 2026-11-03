import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { botName, setBotName } from './branding.js';
import { dataDir, installation, root } from './config.js';
import { run, runJson } from './process.js';

try {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      team: { type: 'string' },
      owner: { type: 'string' },
      name: { type: 'string' },
    },
  });
  const config = installation({
    appId: values.app,
    teamId: values.team,
    ownerId: values.owner,
  });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'installation.json'), JSON.stringify(config), {
    mode: 0o600,
  });
  let name = values.name || botName();
  if (!name) {
    const response = await runJson(
      'slack',
      [
        'api',
        'users.info',
        `user=${config.ownerId}`,
        '--app',
        config.appId,
        '--team',
        config.teamId,
        '--skip-update',
        '--no-color',
      ],
      { cwd: root },
    );
    name = `${response.user.name}-semi`;
  }
  setBotName(name);
  await run(
    'slack',
    [
      'app',
      'install',
      '--app',
      config.appId,
      '--team',
      config.teamId,
      '--skip-update',
      '--no-color',
    ],
    { cwd: root, timeout: 60000 },
  );
  console.log(`Bot name configured: ${name}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
