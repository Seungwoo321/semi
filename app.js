import { randomUUID } from 'node:crypto';
import { App } from '@slack/bolt';
import { installation, root } from './config.js';
import { receiveMessage, selectDmTarget } from './inbox.js';
import { run } from './process.js';
import { Scheduler } from './scheduler.js';
import { Store, validateJob } from './store.js';
import { discover } from './terminals.js';
import { editor, help, routing, sessionPicker, value } from './views.js';

const config = installation();
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
  throw new Error(
    'Start with slack run, or set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env.',
  );
}
const store = new Store();
store.bindInstallation(config);
store.acquireRuntime();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true },
});

const allowed = (user, team) =>
  user === config.ownerId && team === config.teamId;
const safeError = (error) => error.data?.error ?? error.message;
const scheduler = new Scheduler(store, {
  notify: async (run, detail) => {
    await app.client.chat.postMessage({
      channel: run.channel,
      mrkdwn: false,
      ...(run.threadTs && { thread_ts: run.threadTs }),
      text: `[${run.jobName}] ${run.target.label}\n예약 실행 확인 필요: ${detail}\n실행 ID: ${run.id}`,
    });
  },
});

app.message(async ({ message, body, client }) => {
  await receiveMessage(store, config, message, body, client);
});

async function openTargetPicker(client, triggerId, draftId = '') {
  const opened = await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: '세션 조회' },
      close: { type: 'plain_text', text: '닫기' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'plain_text',
            text: '실행 중인 세션을 확인하고 있습니다.',
          },
        },
      ],
    },
  });
  const results = await Promise.allSettled(
    ['orca', 'cmux'].map((provider) => discover(provider)),
  );
  const targets = results
    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    .filter((target) => store.ownsTarget(target.id));
  for (const target of targets) store.putTarget(target);
  await client.views.update({
    view_id: opened.view.id,
    view: sessionPicker(targets, draftId),
  });
}

app.action('choose_dm_session', async ({ ack, body, client, action }) => {
  await ack();
  if (!allowed(body.user.id, body.team?.id)) return;
  await openTargetPicker(client, body.trigger_id, action.value);
});

app.view('dm_target', async ({ ack, body, view, client }) => {
  if (!allowed(body.user.id, body.team?.id)) {
    await ack();
    return;
  }
  let target;
  try {
    target = selectDmTarget(
      store,
      value(view, 'target').selected_option.value,
      view.private_metadata,
    );
  } catch (error) {
    await ack({
      response_action: 'errors',
      errors: { target: safeError(error) },
    });
    return;
  }
  await ack();
  await client.chat.postMessage({
    channel: store.setting('dmChannel'),
    text: `DM 대화 세션: ${target.label}. 이제 이 DM에 요청을 보내세요. 보고 스레드의 답장은 각 원래 세션으로 전달됩니다.`,
    mrkdwn: false,
  });
});

app.command(
  process.env.SEMI_COMMAND || '/semi',
  async ({ command, ack, respond, client }) => {
    if (!allowed(command.user_id, command.team_id)) {
      await ack('이 Mac에 연결된 소유자만 예약을 관리할 수 있습니다.');
      return;
    }
    await ack();
    try {
      const [action = 'help', id] = command.text.trim().split(/\s+/);
      if (action === 'target') {
        await openTargetPicker(client, command.trigger_id);
      } else if (action === 'name') {
        const name = command.text.trim().slice(4).trim();
        if (!name) throw new Error('변경할 이름을 입력하세요.');
        await run(process.execPath, ['setup.js', '--name', name], {
          cwd: root,
          timeout: 60000,
        });
        await respond({
          response_type: 'ephemeral',
          text: `봇 이름을 ${name}으로 설정했습니다.`,
        });
      } else if (action === 'new' || action === 'edit') {
        const job = action === 'edit' ? store.job(id) : null;
        if (action === 'edit' && !job) throw new Error('예약 ID를 확인하세요.');
        const opened = await client.views.open({
          trigger_id: command.trigger_id,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: '세션 조회' },
            close: { type: 'plain_text', text: '닫기' },
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'plain_text',
                  text: 'Orca와 cmux의 실행 중인 세션을 확인하고 있습니다.',
                },
              },
            ],
          },
        });
        const results = await Promise.allSettled(
          ['orca', 'cmux'].map((provider) => discover(provider)),
        );
        const targets = results.flatMap((result) =>
          result.status === 'fulfilled'
            ? result.value.filter((target) => store.ownsTarget(target.id))
            : [],
        );
        const warnings = results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [`${['orca', 'cmux'][index]}: ${safeError(result.reason)}`]
            : [],
        );
        for (const target of targets) store.putTarget(target);
        for (const target of job?.targets ?? []) {
          if (!targets.some((item) => item.id === target.id))
            targets.push({
              ...target,
              label: `[연결 확인 필요] ${target.label}`,
            });
        }
        if (!targets.length) {
          await client.views.update({
            view_id: opened.view.id,
            view: {
              type: 'modal',
              title: { type: 'plain_text', text: '세션 없음' },
              close: { type: 'plain_text', text: '닫기' },
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'plain_text',
                    text: `선택할 세션이 없습니다. Orca 또는 cmux에서 Codex/Claude Code를 실행하고 상태 hooks를 활성화하세요.\n${warnings.join('\n')}`,
                  },
                },
              ],
            },
          });
          return;
        }
        const view = editor(
          job,
          targets,
          job?.channel || store.setting('defaultChannel') || command.channel_id,
        );
        if (warnings.length)
          view.blocks.push({
            type: 'context',
            elements: [
              { type: 'plain_text', text: warnings.join('\n').slice(0, 2000) },
            ],
          });
        await client.views.update({ view_id: opened.view.id, view });
      } else if (action === 'list') {
        const jobs = store.jobs();
        await respond({
          response_type: 'ephemeral',
          text: jobs.length
            ? jobs
                .map(
                  (job) =>
                    `${job.enabled ? '실행' : '중지'} · ${job.name} · ${job.minutes}분 · ${job.targets.length}개 세션\n\`${job.id}\``,
                )
                .join('\n\n')
            : '예약이 없습니다. `/semi new`로 만드세요.',
        });
      } else if (['pause', 'resume', 'delete', 'status'].includes(action)) {
        if (!store.job(id)) throw new Error('예약 ID를 확인하세요.');
        if (action === 'status') {
          await respond({
            response_type: 'ephemeral',
            text:
              store
                .runs(id)
                .map(
                  (run) =>
                    `${run.target.label} · ${run.status} · <#${run.channel}>\n\`${run.id}\``,
                )
                .join('\n\n') || '실행 기록이 없습니다.',
          });
          return;
        }
        if (action === 'delete') store.deleteJob(id);
        else store.toggleJob(id, action === 'resume');
        await respond({ response_type: 'ephemeral', text: `${action}: ${id}` });
      } else if (action === 'resolve') {
        if (!store.resolve(id))
          throw new Error(
            '해제할 수 있는 submitted/uncertain 실행 ID가 아닙니다.',
          );
        await respond({
          response_type: 'ephemeral',
          text: '대기를 해제했습니다. 이미 전달된 작업은 취소되지 않습니다. 다음 예약 시각부터 새 요청이 가능합니다.',
        });
      } else if (action === 'default-channel') {
        if (!/^[CGD][A-Z0-9]+$/.test(command.channel_id))
          throw new Error('채널에서 실행하세요.');
        store.setSetting('defaultChannel', command.channel_id);
        await respond({
          response_type: 'ephemeral',
          text: `기본 채널을 <#${command.channel_id}>로 지정했습니다. 예약·세션에 지정한 채널이 우선합니다.`,
        });
      } else {
        await respond({ response_type: 'ephemeral', text: help() });
      }
    } catch (error) {
      await respond({
        response_type: 'ephemeral',
        text: `처리하지 못했습니다: ${safeError(error)}`,
      });
    }
  },
);

app.view('schedule_details', async ({ ack, body, view }) => {
  if (!allowed(body.user.id, body.team?.id)) {
    await ack();
    return;
  }
  try {
    const existing = view.private_metadata
      ? store.job(view.private_metadata)
      : null;
    if (view.private_metadata && !existing)
      throw new Error('예약이 삭제되었습니다.');
    const job = {
      ...(existing && { id: existing.id, enabled: existing.enabled }),
      name: value(view, 'name').value.trim(),
      minutes: Number(value(view, 'minutes').value),
      prompt: value(view, 'prompt').value.trim(),
      channel: value(view, 'channel')?.selected_conversation || '',
      targets: value(view, 'targets').selected_options.map(({ value: id }) => {
        const target = store.target(id);
        if (!target) throw new Error('세션을 다시 선택하세요.');
        return {
          ...target,
          channel:
            existing?.targets.find((item) => item.id === id)?.channel || '',
        };
      }),
    };
    validateJob(job);
    const draftId = randomUUID();
    store.setSetting(`draft:${draftId}`, JSON.stringify(job));
    await ack({ response_action: 'update', view: routing(draftId, job) });
  } catch (error) {
    await ack({
      response_action: 'errors',
      errors: { name: safeError(error) },
    });
  }
});

app.view('schedule_routes', async ({ ack, body, view }) => {
  if (!allowed(body.user.id, body.team?.id)) {
    await ack();
    return;
  }
  try {
    const draft = store.setting(`draft:${view.private_metadata}`);
    if (!draft) throw new Error('예약 양식이 만료되었습니다.');
    const job = JSON.parse(draft);
    for (const [index, target] of job.targets.entries())
      target.channel =
        value(view, `target_${index}`)?.selected_conversation || '';
    validateJob(job);
    if (
      job.targets.some(
        (target) =>
          !(target.channel || job.channel || store.setting('defaultChannel')),
      )
    ) {
      throw new Error('모든 세션에 결과 채널이 필요합니다.');
    }
    const id = store.saveJob(job);
    store.db
      .prepare('DELETE FROM settings WHERE key=?')
      .run(`draft:${view.private_metadata}`);
    await ack({
      response_action: 'update',
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: '예약 저장 완료' },
        close: { type: 'plain_text', text: '닫기' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'plain_text',
              text: `${job.name}\n${job.minutes}분 간격 · ${job.targets.length}개 세션\n예약 ID: ${id}\n${job.enabled === false ? '중지 상태를 유지합니다.' : '첫 요청은 설정한 간격 후에 생성됩니다.'}`,
            },
          },
        ],
      },
    });
  } catch (error) {
    await ack({
      response_action: 'errors',
      errors: { target_0: safeError(error) },
    });
  }
});

let timer;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await app.stop();
  while (scheduler.running)
    await new Promise((resolve) => setTimeout(resolve, 100));
  store.releaseRuntime();
  store.close();
}
app.error(async (error) => console.error(`Slack: ${safeError(error)}`));
process.once('SIGINT', () => {
  close().then(() => process.exit());
});
process.once('SIGTERM', () => {
  close().then(() => process.exit());
});
try {
  const identity = await app.client.auth.test();
  if (!identity.bot_id || identity.team_id !== config.teamId)
    throw new Error('Configured token is not a bot in the expected workspace.');
  const dm = await app.client.conversations.open({ users: config.ownerId });
  store.setDmChannel(dm.channel.id);
  store.recover();
  await app.start();
  timer = setInterval(
    () => scheduler.tick().catch((error) => console.error(safeError(error))),
    10000,
  );
  await scheduler.tick();
  console.log('Semi scheduler connected. Use /semi in Slack.');
} catch (error) {
  await close();
  console.error(safeError(error));
  process.exitCode = 1;
}
