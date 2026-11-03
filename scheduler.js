import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, profile, root } from './config.js';
import { dispatch, ready } from './terminals.js';

export const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function taskPrompt(run, base = root, directory = dataDir) {
  const folder = join(directory, 'runs');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${run.id}.md`);
  const command = `SEMI_PROFILE=${quote(profile)} ${quote(process.execPath)} ${quote(join(base, 'cli.js'))} report ${run.id}`;
  writeFileSync(
    path,
    [
      `# 예약 작업: ${run.jobName}`,
      `대상: ${run.target.label}`,
      '',
      '사용자가 등록한 다음 작업을 현재 세션의 맥락에서 수행하세요. 작업 범위와 기존 승인 경계를 유지하세요.',
      '',
      run.prompt,
      '',
      '실행 결과 또는 실행할 수 없는 이유를 간결하게 작성하세요. 비밀 값과 불필요한 원문 로그를 포함하지 마세요.',
      '아래 명령의 표준입력으로 결과를 보내세요. 채널과 세션 표시는 프로그램이 적용합니다.',
      '본문은 3500자 이내로 작성하고, 셸 확장을 막기 위해 따옴표로 감싼 heredoc 구분자를 사용하세요.',
      '',
      '```sh',
      `${command} <<'REPORT_RESULT'`,
      '결과 본문',
      'REPORT_RESULT',
      '```',
      '',
      '전송 결과가 불확실하면 같은 보고를 재전송하지 말고 사용자에게 알리세요.',
    ].join('\n'),
    { mode: 0o600 },
  );
  return `# Scheduled task ${run.id}. Read the local task file ${quote(path)} and follow its instructions.`;
}

export class Scheduler {
  constructor(
    store,
    {
      isReady = ready,
      send = dispatch,
      prompt = taskPrompt,
      notify = async () => {},
    } = {},
  ) {
    this.store = store;
    this.isReady = isReady;
    this.send = send;
    this.prompt = prompt;
    this.notify = notify;
    this.running = false;
  }
  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      this.store.claim(now);
      const targets = new Set();
      const waiting = this.store.waiting().filter((run) => {
        const job = this.store.job(run.job_id);
        if (
          run.kind !== 'reply' &&
          (!job?.enabled ||
            !job.targets.some((target) => target.id === run.target.id))
        )
          return false;
        if (
          targets.has(run.target.id) ||
          this.store.activeTarget(run.target.id)
        )
          return false;
        targets.add(run.target.id);
        return true;
      });
      await Promise.allSettled(
        waiting.map(async (run) => {
          let started = false;
          try {
            if (!(await this.isReady(run.target))) return;
            const text = this.prompt(run);
            if (!this.store.transition(run.id, 'waiting', 'dispatching'))
              return;
            started = true;
            const receipt = await this.send(run.target, text);
            this.store.transition(
              run.id,
              'dispatching',
              'submitted',
              JSON.stringify(receipt),
            );
          } catch (error) {
            this.store.transition(
              run.id,
              started ? 'dispatching' : 'waiting',
              started ? 'uncertain' : 'failed',
              error.message,
            );
            await this.notify(run, error.message);
          }
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
