import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installAgent } from '../launch-agent.js';
import { run } from '../process.js';

const failure = (code) => Object.assign(new Error(`failure ${code}`), { code });
function fixture(t, previous = 'old plist') {
  const directory = mkdtempSync(join(tmpdir(), 'semi-agent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'service.plist');
  if (previous) writeFileSync(file, previous);
  return {
    file,
    domain: 'gui/501',
    service: 'gui/501/dev.semi.test',
    plist: 'new plist',
  };
}

test('reinstall waits for actual removal before bootstrap', async (t) => {
  const config = fixture(t);
  const calls = [];
  let stopping = false;
  let remaining = 2;
  await installAgent(config, async (command, [action]) => {
    calls.push(action);
    if (command === '/usr/bin/plutil') {
      assert.equal(readFileSync(config.file, 'utf8'), 'old plist');
    } else if (action === 'bootout') stopping = true;
    else if (action === 'print' && stopping) {
      assert.equal(readFileSync(config.file, 'utf8'), 'old plist');
      if (remaining-- === 0) throw failure(113);
    } else if (action === 'bootstrap') {
      assert.equal(remaining, -1);
      assert.equal(readFileSync(config.file, 'utf8'), 'new plist');
    }
  });
  assert.deepEqual(calls, [
    '-lint',
    'print',
    'bootout',
    'print',
    'print',
    'print',
    'bootstrap',
  ]);
  assert.deepEqual(readdirSync(join(config.file, '..')), ['service.plist']);
});

test('invalid candidate or service inspection failure preserves the existing service', async (t) => {
  for (const failedAction of ['-lint', 'print']) {
    const config = fixture(t);
    const calls = [];
    await assert.rejects(
      installAgent(config, async (_, [action]) => {
        calls.push(action);
        if (action === failedAction) throw failure(1);
      }),
      /failure 1/,
    );
    assert.equal(calls.includes('bootout'), false);
    assert.equal(readFileSync(config.file, 'utf8'), 'old plist');
  }
});

test('failed replacement restores the previous plist and loaded service', async (t) => {
  const config = fixture(t);
  let loaded = true;
  const bootstraps = [];
  await assert.rejects(
    installAgent(config, async (_, [action]) => {
      if (action === 'print' && !loaded) throw failure(113);
      if (action === 'bootout') loaded = false;
      if (action === 'bootstrap') {
        const plist = readFileSync(config.file, 'utf8');
        bootstraps.push(plist);
        if (plist === 'new plist') throw failure(5);
        loaded = true;
      }
    }),
    /previous configuration and service registration were restored/,
  );
  assert.deepEqual(bootstraps, ['new plist', 'old plist']);
  assert.equal(loaded, true);
  assert.equal(readFileSync(config.file, 'utf8'), 'old plist');
});

test('ambiguous bootstrap does not unload a registered service or retry', async (t) => {
  for (const inspection of ['registered', 'unknown']) {
    const config = fixture(t);
    let bootstraps = 0;
    let removed = false;
    await assert.rejects(
      installAgent(config, async (_, [action]) => {
        if (action === 'bootout') removed = true;
        if (action === 'print' && removed) {
          if (!bootstraps) throw failure(113);
          if (inspection === 'unknown') throw failure(1);
        }
        if (action === 'bootstrap') {
          bootstraps++;
          throw failure(5);
        }
      }),
      /uncertain|service is registered/,
    );
    assert.equal(bootstraps, 1);
    assert.equal(readFileSync(config.file, 'utf8'), 'new plist');
  }
});

test('failed first install removes the candidate; an existing unloaded config remains unloaded', async (t) => {
  for (const previous of [undefined, 'old plist']) {
    const config = fixture(t, previous ?? '');
    let bootstraps = 0;
    await assert.rejects(
      installAgent(config, async (_, [action]) => {
        if (action === 'print') throw failure(113);
        if (action === 'bootstrap') {
          bootstraps++;
          throw failure(5);
        }
      }),
      /previous configuration was restored/,
    );
    assert.equal(bootstraps, 1);
    assert.equal(existsSync(config.file), !!previous);
    if (previous) assert.equal(readFileSync(config.file, 'utf8'), previous);
  }
});

test('recovery failure is explicit and retains the original configuration', async (t) => {
  const config = fixture(t);
  let loaded = true;
  let bootstraps = 0;
  await assert.rejects(
    installAgent(config, async (_, [action]) => {
      if (action === 'print' && !loaded) throw failure(113);
      if (action === 'bootout') loaded = false;
      if (action === 'bootstrap') {
        bootstraps++;
        throw failure(5);
      }
    }),
    /recovery failed/,
  );
  assert.equal(bootstraps, 2);
  assert.equal(readFileSync(config.file, 'utf8'), 'old plist');
});

test('process failures expose exit codes without exposing command output', async () => {
  await assert.rejects(
    run(process.execPath, [
      '-e',
      'console.error("private-output"); process.exit(113)',
    ]),
    (error) => {
      assert.equal(error.code, 113);
      assert.equal(error.message.includes('private-output'), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
