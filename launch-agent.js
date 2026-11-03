import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { run } from './process.js';

export async function installAgent(
  { domain, service, file, plist },
  execute = run,
) {
  const temporary = mkdtempSync(join(dirname(file), '.semi-install-'));
  const candidate = join(temporary, 'agent.plist');
  async function loaded() {
    try {
      await execute('/bin/launchctl', ['print', service]);
      return true;
    } catch (error) {
      if (error.code === 113) return false;
      throw error;
    }
  }
  try {
    let previous;
    try {
      previous = readFileSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    writeFileSync(candidate, plist, { mode: 0o600 });
    await execute('/usr/bin/plutil', ['-lint', candidate]);
    const wasLoaded = await loaded();
    if (wasLoaded && !previous)
      throw new Error(
        'The loaded service has no saved plist. Restore it before reinstalling.',
      );
    if (wasLoaded) {
      await execute('/bin/launchctl', ['bootout', service]);
      const deadline = Date.now() + 30000;
      while (await loaded()) {
        if (Date.now() >= deadline)
          throw new Error(
            'Service removal timed out. The previous plist is retained; inspect the service before reinstalling.',
          );
        await setTimeout(100);
      }
    }
    renameSync(candidate, file);
    try {
      await execute('/bin/launchctl', ['bootstrap', domain, file]);
    } catch (error) {
      let present;
      try {
        present = await loaded();
      } catch {
        throw new Error(
          'Installation outcome is uncertain. The new plist is retained; inspect the service before retrying.',
        );
      }
      if (present)
        throw new Error(
          'Installation reported an error but the service is registered. Inspect it before retrying.',
        );
      try {
        if (previous) {
          writeFileSync(candidate, previous, { mode: 0o600 });
          renameSync(candidate, file);
          if (wasLoaded)
            await execute('/bin/launchctl', ['bootstrap', domain, file]);
        } else {
          rmSync(file);
        }
      } catch (recovery) {
        throw new Error(
          `Installation failed (${error.code ?? 'unknown'}); recovery failed: ${recovery.message}`,
        );
      }
      throw new Error(
        `Installation failed (${error.code ?? 'unknown'}); the previous configuration${wasLoaded ? ' and service registration were' : ' was'} restored.`,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
