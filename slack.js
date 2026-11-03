import { webApi } from '@slack/bolt';
import { installation, root } from './config.js';
import { runJson } from './process.js';

export function validateMessage(channel, text) {
  if (!/^[CGD][A-Z0-9]+$/.test(channel ?? ''))
    throw new Error('A Slack channel ID is required.');
  if (typeof text !== 'string' || !text.trim())
    throw new Error('Message must not be empty.');
  if ([...text].length > 4000)
    throw new Error(
      'Message exceeds 4000 characters; shorten it before sending.',
    );
}

export async function postMessage(
  channel,
  text,
  { api, threadTs, config = installation() } = {},
) {
  validateMessage(channel, text);
  const token = process.env.SLACK_BOT_TOKEN;
  const client = token
    ? new webApi.WebClient(token, {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
      })
    : null;
  const call =
    api ??
    (async (method, body = {}) => {
      if (client) return client.apiCall(method, body);
      return runJson(
        'slack',
        [
          'api',
          method,
          '--app',
          config.appId,
          '--team',
          config.teamId,
          '--skip-update',
          '--no-color',
          '--json',
          JSON.stringify(body),
        ],
        { cwd: root },
      );
    });
  const auth = await call('auth.test');
  if (!auth.ok || !auth.bot_id || auth.team_id !== config.teamId) {
    throw new Error(
      'Slack authentication must be a bot in the configured workspace.',
    );
  }
  const result = await call('chat.postMessage', {
    channel,
    text,
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
    ...(threadTs && { thread_ts: threadTs }),
  });
  if (!result.ok || !result.ts)
    throw new Error(`Slack send failed: ${result.error ?? 'unconfirmed'}`);
  return { channel: result.channel, ts: result.ts, botId: auth.bot_id };
}
