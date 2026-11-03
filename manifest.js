import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProtocol } from '@slack/cli-hooks/src/protocols.js';
import { botName } from './branding.js';
import { root } from './config.js';

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (process.env.SEMI_COMMAND)
  manifest.features.slash_commands[0].command = process.env.SEMI_COMMAND;
const name = botName();
if (name) {
  manifest.display_information.name = name;
  manifest.features.bot_user.display_name = name;
}
getProtocol(process.argv.slice(1)).respond(JSON.stringify(manifest));
