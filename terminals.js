import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { run, runJson } from './process.js';

const orca =
  process.env.ORCA_CLI_COMMAND ||
  (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : 'orca');
const supported = (agent) => ['codex', 'claude'].includes(agent);
const key = (...parts) =>
  createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 24);
const context = (target) => [
  '--workspace',
  target.workspace,
  '--surface',
  target.surface,
];

export async function discover(provider, json = runJson) {
  if (provider === 'orca') {
    const response = await json(orca, ['terminal', 'list', '--json']);
    if (response.result.truncated)
      throw new Error('Orca terminal list was truncated.');
    return response.result.terminals
      .filter(
        (item) =>
          supported(item.agentIdentity) &&
          item.connected &&
          item.writable &&
          !item.orphaned &&
          item.executionHostId === 'local',
      )
      .map((item) => ({
        id: key('orca', item.handle, item.incarnationId),
        provider,
        agent: item.agentIdentity,
        handle: item.handle,
        incarnation: item.incarnationId,
        label: `orca · ${item.agentIdentity} · ${item.paneTitle || item.title || basename(item.worktreePath)} · ${item.handle.slice(-6)}`,
      }));
  }
  if (provider !== 'cmux') throw new Error('Unknown terminal provider.');
  const response = await json('cmux', ['sessions', 'list', '--json', '--all']);
  return response.sessions
    .filter(
      (item) =>
        supported(item.agent) &&
        item.stored_pid_exists &&
        item.workspace_id &&
        item.surface_id &&
        item.session_id &&
        !['exited', 'stopped'].includes(item.agent_lifecycle),
    )
    .map((item) => ({
      id: key('cmux', item.workspace_id, item.surface_id, item.session_id),
      provider,
      agent: item.agent,
      workspace: item.workspace_id,
      surface: item.surface_id,
      session: item.session_id,
      label: `cmux · ${item.agent} · ${basename(item.cwd || 'session')} · ${item.session_id.slice(-6)}`,
    }));
}

export async function ready(target, json = runJson) {
  if (target.provider === 'orca') {
    const { result } = await json(orca, [
      'terminal',
      'show',
      '--terminal',
      target.handle,
      '--json',
    ]);
    const terminal = result.terminal;
    if (
      terminal.incarnationId !== target.incarnation ||
      terminal.agentIdentity !== target.agent ||
      !terminal.connected ||
      !terminal.writable ||
      terminal.orphaned ||
      terminal.executionHostId !== 'local'
    ) {
      throw new Error(
        'Orca session changed or ended. Select its replacement explicitly.',
      );
    }
    try {
      await json(orca, [
        'terminal',
        'wait',
        '--terminal',
        target.handle,
        '--for',
        'tui-idle',
        '--timeout-ms',
        '1',
        '--json',
      ]);
      return true;
    } catch {
      return false;
    }
  }
  if (target.provider !== 'cmux') throw new Error('Unknown terminal provider.');
  const data = await json('cmux', [
    'sessions',
    'list',
    '--agent',
    target.agent,
    '--session',
    target.session,
    '--json',
  ]);
  const session = data.sessions.find(
    (item) =>
      item.session_id === target.session &&
      item.surface_id === target.surface &&
      item.workspace_id === target.workspace &&
      item.stored_pid_exists,
  );
  if (!session)
    throw new Error('cmux session ended. Select its replacement explicitly.');
  const state = await json('cmux', [
    '--json',
    'surface',
    'resume',
    'show',
    ...context(target),
  ]);
  const binding = state.resume_binding;
  if (
    binding?.checkpoint_id !== target.session ||
    binding.kind !== target.agent ||
    (binding.execution_location && binding.execution_location !== 'local')
  ) {
    throw new Error('cmux session binding changed or is remote.');
  }
  return session.agent_lifecycle === 'idle';
}

export async function dispatch(target, text, execute = run, json = runJson) {
  if (
    [...text].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      'Terminal prompt must be one line without control characters.',
    );
  if (target.provider === 'orca') {
    await execute(orca, [
      'terminal',
      'read',
      '--terminal',
      target.handle,
      '--screen',
      '--json',
    ]);
    const receipt = await json(orca, [
      'terminal',
      'send',
      '--terminal',
      target.handle,
      '--text',
      text,
      '--enter',
      '--wait-submit',
      '2',
      '--json',
    ]);
    return receipt.result;
  }
  if (target.provider !== 'cmux') throw new Error('Unknown terminal provider.');
  const screen = await execute('cmux', [
    'read-screen',
    ...context(target),
    '--lines',
    '15',
  ]);
  if (/allow|permission|approve|trust|허용|권한|승인/i.test(screen)) {
    throw new Error(
      'cmux may be showing an approval prompt; no input was sent.',
    );
  }
  if (!(await ready(target, json)))
    throw new Error('cmux is no longer idle; no input was sent.');
  await execute('cmux', ['send', ...context(target), text]);
  await execute('cmux', ['send-key', ...context(target), 'Enter']);
  return { input_accepted: true, turn_started: false };
}
