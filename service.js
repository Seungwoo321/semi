import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dataDir, installation, profile, root } from './config.js';
import { installAgent } from './launch-agent.js';
import { run } from './process.js';

const label = `dev.semi.agent.${profile}`;
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const file = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const escapeXml = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const action = process.argv[2];
try {
  if (process.platform !== 'darwin')
    throw new Error('The service installer requires macOS.');
  if (action === 'install') {
    installation();
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
      throw new Error(
        'Configure bot and app tokens in the profile .env file before installing the service.',
      );
    }
    const args = [process.execPath, join(root, 'app.js')];
    const path = [
      dirname(process.execPath),
      join(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':');
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escapeXml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(path)}</string><key>HOME</key><string>${escapeXml(homedir())}</string><key>SEMI_PROFILE</key><string>${profile}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${escapeXml(join(dataDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${escapeXml(join(dataDir, 'service-error.log'))}</string>
</dict></plist>`;
    await installAgent({ domain, service, file, plist });
    console.log(
      'Semi service installed. Run pnpm run service status to inspect it.',
    );
  } else if (action === 'uninstall') {
    await run('/bin/launchctl', ['bootout', service]);
    rmSync(file, { force: true });
    console.log(
      'Semi service removed. Schedules and local configuration are retained.',
    );
  } else if (action === 'status') {
    const output = await run('/bin/launchctl', ['print', service]);
    console.log(
      output
        .split('\n')
        .filter((line) => /state =|pid =|last exit code =/.test(line))
        .join('\n'),
    );
  } else {
    console.log('Usage: pnpm run service install|status|uninstall');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
