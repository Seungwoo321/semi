import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { root } from '../config.js';
import { receiveMessage, selectDmTarget } from '../inbox.js';
import { report } from '../report.js';
import { Scheduler, taskPrompt } from '../scheduler.js';
import { postMessage } from '../slack.js';
import { Store } from '../store.js';
import { discover, dispatch, ready } from '../terminals.js';

const first = {
  id: 'one',
  provider: 'cmux',
  agent: 'codex',
  label: 'Codex A',
  channel: 'CPROJECTA',
};
const second = {
  id: 'two',
  provider: 'orca',
  agent: 'claude',
  label: 'Claude B',
  channel: '',
};
const job = (targets = [first, second]) => ({
  name: 'Review',
  minutes: 30,
  prompt: 'Check tests',
  channel: 'CDEFAULT',
  targets,
});
mkdirSync(join(root, '.local'), { recursive: true });
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const id = store.saveJob(job(), 0);
  return { store, id };
}

test('one schedule fans out with session channels; missed intervals coalesce and pending runs do not duplicate', (t) => {
  const { store, id } = fixture(t);
  assert.equal(store.claim(1799999).length, 0);
  const runs = store.claim(1800000 * 10);
  assert.deepEqual(
    runs.map((run) => run.channel),
    ['CPROJECTA', 'CDEFAULT'],
  );
  assert.equal(store.claim(1800000 * 20).length, 0);
  assert.equal(store.runs(id).length, 2);
  assert.equal(store.job(id).nextAt, 1800000 * 21);
});

test('busy session waits; another session executes; an uncertain send is never automatically retried', async (t) => {
  const { store, id } = fixture(t);
  let busy = true;
  const sent = [];
  const scheduler = new Scheduler(store, {
    isReady: async (target) => target.id !== 'one' || !busy,
    prompt: (run) => run.id,
    send: async (target) => {
      sent.push(target.id);
      if (target.id === 'two') throw new Error('connection lost');
      return {};
    },
  });
  await scheduler.tick(1800000);
  assert.deepEqual(sent, ['two']);
  assert.equal(
    store.runs(id).find((run) => run.target.id === 'two').status,
    'uncertain',
  );
  busy = false;
  await scheduler.tick(1800010);
  await scheduler.tick(3600000);
  assert.deepEqual(sent, ['two', 'one']);
});

test('multiple schedules for the same session never inject concurrently', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveJob(job([first]), 0);
  store.saveJob(job([first]), 0);
  let sends = 0;
  const scheduler = new Scheduler(store, {
    isReady: async () => true,
    prompt: () => 'prompt',
    send: async () => {
      sends++;
      return {};
    },
  });
  await scheduler.tick(1800000);
  await scheduler.tick(1800010);
  assert.equal(sends, 1);
  assert.equal(store.waiting().length, 1);
});

test('restart preserves jobs and converts ambiguous in-flight work to uncertain', (t) => {
  const directory = mkdtempSync(join(root, '.local', 'store-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const file = join(directory, 'state.sqlite');
  let store = new Store(file);
  const id = store.saveJob(job(), 0);
  const [run] = store.claim(1800000);
  store.transition(run.id, 'waiting', 'dispatching');
  store.close();
  store = new Store(file);
  store.recover();
  assert.equal(store.run(run.id).status, 'uncertain');
  assert.equal(store.job(id).targets.length, 2);
  store.close();
});

test('reports bind the correct thread and duplicate replies deliver once; follow-up results stay in the thread', async (t) => {
  const { store } = fixture(t);
  const [run] = store.claim(1800000);
  store.transition(run.id, 'waiting', 'submitted');
  const calls = [];
  const send = async (channel, text, { threadTs }) => {
    calls.push({ channel, text, threadTs });
    return { channel, ts: `${calls.length}.000001` };
  };
  await report(store, run.id, 'Tests passed', send);
  await assert.rejects(report(store, run.id, 'Again', send));
  const original = store.messageRun('CPROJECTA', '1.000001');
  assert.equal(original.target.id, first.id);
  assert.equal(store.messageRun('COTHER', '1.000001'), null);
  const reply = store.enqueueReply(
    'EV1',
    original,
    'Explain the change',
    '1.000001',
  );
  assert.equal(
    store.enqueueReply('EV1', original, 'Explain the change', '1.000001'),
    null,
  );
  store.transition(reply, 'waiting', 'submitted');
  await report(store, reply, 'Explanation', send);
  assert.equal(calls[1].threadTs, '1.000001');
  assert.equal(calls[1].channel, 'CPROJECTA');
});

test('empty report never sends; Slack timeout becomes uncertain and cannot be resent', async (t) => {
  const { store } = fixture(t);
  const [run] = store.claim(1800000);
  store.transition(run.id, 'waiting', 'submitted');
  let sends = 0;
  const send = async () => {
    sends++;
    throw new Error('timeout');
  };
  await assert.rejects(report(store, run.id, '', send));
  assert.equal(sends, 0);
  await assert.rejects(report(store, run.id, 'Result', send));
  await assert.rejects(report(store, run.id, 'Retry', send));
  assert.equal(sends, 1);
  assert.equal(store.run(run.id).status, 'uncertain');
});

test('bot authentication cannot silently fall back to a user token or another workspace', async () => {
  const config = { appId: 'ATEST', teamId: 'TTEST', ownerId: 'UTEST' };
  let posts = 0;
  for (const identity of [
    { ok: true, team_id: 'TTEST' },
    { ok: true, team_id: 'TOTHER', bot_id: 'BBOT' },
  ]) {
    await assert.rejects(
      postMessage('CTEST', 'hello', {
        config,
        api: async (method) => {
          if (method === 'chat.postMessage') posts++;
          return identity;
        },
      }),
    );
  }
  assert.equal(posts, 0);
  const content = 'Quotes: "$()"\n두 번째 줄';
  await postMessage('CTEST', content, {
    config,
    api: async (method, body) => {
      if (method === 'auth.test')
        return { ok: true, team_id: 'TTEST', bot_id: 'BBOT' };
      assert.equal(body.text, content);
      assert.equal(body.mrkdwn, false);
      return { ok: true, channel: body.channel, ts: '1.000001' };
    },
  });
});

test('cmux refuses stale session bindings and never submits after text delivery fails', async () => {
  const target = {
    ...first,
    session: 'session',
    workspace: 'workspace',
    surface: 'surface',
  };
  const sessions = {
    sessions: [
      {
        session_id: 'session',
        workspace_id: 'workspace',
        surface_id: 'surface',
        stored_pid_exists: true,
        agent_lifecycle: 'idle',
      },
    ],
  };
  await assert.rejects(
    ready(target, async (_, args) =>
      args.includes('sessions')
        ? sessions
        : { resume_binding: { checkpoint_id: 'different', kind: 'codex' } },
    ),
  );
  const calls = [];
  const json = async (_, args) =>
    args.includes('sessions')
      ? sessions
      : {
          resume_binding: {
            checkpoint_id: 'session',
            kind: 'codex',
            execution_location: 'local',
          },
        };
  await assert.rejects(
    dispatch(
      target,
      'safe prompt',
      async (_, args) => {
        calls.push(args[0]);
        if (args[0] === 'send') throw new Error('failed');
        return '> ready';
      },
      json,
    ),
  );
  assert.deepEqual(calls, ['read-screen', 'send']);
});

test('Orca discovery excludes shells and remote sessions; send uses the exact handle once', async () => {
  const terminal = {
    handle: 'term_1',
    incarnationId: 'inc_1',
    agentIdentity: 'claude',
    connected: true,
    writable: true,
    executionHostId: 'local',
    title: 'Claude',
  };
  const targets = await discover('orca', async () => ({
    result: {
      terminals: [
        terminal,
        { ...terminal, agentIdentity: undefined },
        { ...terminal, executionHostId: 'remote' },
      ],
    },
  }));
  assert.equal(targets.length, 1);
  let sends = 0;
  await dispatch(
    targets[0],
    'safe prompt',
    async () => '{}',
    async (_, args) => {
      sends++;
      assert.equal(args[args.indexOf('--terminal') + 1], 'term_1');
      assert.ok(args.includes('--wait-submit'));
      return { result: { accepted: true } };
    },
  );
  assert.equal(sends, 1);
});

test('terminal input carries only a safely quoted task-file path; user prompt stays in a private file', (t) => {
  const directory = mkdtempSync(join(root, '.local', 'prompt-test-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const run = {
    id: 'test-run',
    jobName: 'Test',
    target: first,
    prompt: 'echo $(danger)\nsecond line',
  };
  const text = taskPrompt(run, directory, join(directory, '.local'));
  assert.ok(!text.includes('$(danger)'));
  assert.ok(!text.includes('\n'));
  assert.ok(
    readFileSync(
      join(directory, '.local', 'runs', 'test-run.md'),
      'utf8',
    ).includes(run.prompt),
  );
});

test('personal and work profiles cannot claim the same session or read each other’s reports', (t) => {
  const directory = mkdtempSync(join(root, '.local', 'profiles-test-'));
  const owners = join(directory, 'owners.sqlite');
  const personal = new Store(
    join(directory, 'personal.sqlite'),
    owners,
    'personal',
  );
  const work = new Store(join(directory, 'work.sqlite'), owners, 'work');
  t.after(() => {
    personal.close();
    work.close();
    rmSync(directory, { recursive: true });
  });
  personal.saveJob(job([first]), 0);
  assert.throws(() => work.saveJob(job([first]), 0), /another Semi profile/);
  assert.equal(work.jobs().length, 0);
  assert.equal(work.ownsTarget(first.id), false);
  assert.equal(work.messageRun('CPROJECTA', '1.000001'), null);
  work.saveJob(job([second]), 0);
  assert.equal(work.jobs().length, 1);
});

test('DM requests require the configured owner/workspace and preserve the first prompt through session selection', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setSetting('dmChannel', 'DOWNER');
  store.putTarget(first);
  const config = { teamId: 'TOWNER', ownerId: 'UOWNER' };
  const posts = [];
  const client = {
    chat: {
      postMessage: async (body) => {
        posts.push(body);
        return { ok: true };
      },
    },
  };
  const message = {
    user: 'UOWNER',
    channel: 'DOWNER',
    text: 'Check the build',
    ts: '10.000001',
  };
  await receiveMessage(
    store,
    config,
    { ...message, user: 'UOTHER' },
    { event_id: 'EVBAD', team_id: 'TOWNER' },
    client,
  );
  await receiveMessage(
    store,
    config,
    message,
    { event_id: 'EVBADTEAM', team_id: 'TOTHER' },
    client,
  );
  assert.equal(posts.length, 0);
  const event = { event_id: 'EVGOOD', team_id: 'TOWNER' };
  await receiveMessage(store, config, message, event, client);
  await receiveMessage(store, config, message, event, client);
  assert.equal(posts.length, 1);
  const draftId = posts[0].blocks[1].elements[0].value;
  selectDmTarget(store, first.id, draftId);
  const [run] = store.waiting();
  assert.equal(run.prompt, message.text);
  assert.equal(run.channel, 'DOWNER');
  assert.equal(run.threadTs, message.ts);
  await receiveMessage(store, config, message, event, client);
  assert.equal(store.waiting().length, 1);
});

test('unlinked DM threads bind once and retain their session after changing the DM target', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setSetting('dmChannel', 'DOWNER');
  store.putTarget(first);
  store.putTarget(second);
  selectDmTarget(store, first.id);
  const posts = [];
  const client = { chat: { postMessage: async (body) => posts.push(body) } };
  const config = { teamId: 'TOWNER', ownerId: 'UOWNER' };
  const message = {
    user: 'UOWNER',
    channel: 'DOWNER',
    text: 'Report progress',
    ts: '20.000002',
    thread_ts: '20.000001',
  };
  const event = { event_id: 'EVTHREAD', team_id: 'TOWNER' };
  await receiveMessage(store, config, message, event, client);
  await receiveMessage(store, config, message, event, client);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread_ts, message.thread_ts);
  assert.equal(store.waiting()[0].target.id, first.id);
  selectDmTarget(store, second.id);
  await receiveMessage(
    store,
    config,
    { ...message, ts: '20.000003' },
    { ...event, event_id: 'EVFOLLOWUP' },
    client,
  );
  assert.deepEqual(
    store.waiting().map((run) => run.target.id),
    [first.id, first.id],
  );
  await receiveMessage(
    store,
    config,
    { ...message, channel: 'CUNLINKED' },
    { ...event, event_id: 'EVCHANNEL' },
    client,
  );
  assert.equal(store.waiting().length, 2);
});

test('default reporting uses DM while an explicit session destination takes precedence', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setSetting('defaultChannel', 'DOWNER');
  store.saveJob({ ...job(), channel: '' }, 0);
  assert.deepEqual(
    store.claim(1800000).map((run) => run.channel),
    ['CPROJECTA', 'DOWNER'],
  );
});

test('a profile cannot be reused for a different Slack identity; DM initialization preserves explicit channel defaults', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = { teamId: 'TPERSONAL', ownerId: 'UOWNER', appId: 'ASEMI' };
  store.bindInstallation(config);
  assert.throws(
    () => store.bindInstallation({ ...config, teamId: 'TWORK' }),
    /another Slack installation/,
  );
  store.setDmChannel('DOLD');
  store.setDmChannel('DNEW');
  assert.equal(store.setting('defaultChannel'), 'DNEW');
  store.setSetting('defaultChannel', 'CEXPLICIT');
  store.setDmChannel('DTHIRD');
  assert.equal(store.setting('defaultChannel'), 'CEXPLICIT');
});
