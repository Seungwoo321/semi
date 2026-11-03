import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath, ownershipPath, profile } from './config.js';

export class Store {
  constructor(
    path = databasePath,
    owners = path === databasePath ? ownershipPath : ':memory:',
    profileName = profile,
  ) {
    this.profile = profileName;
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.prepare('ATTACH DATABASE ? AS owners').run(owners);
    if (owners !== ':memory:') chmodSync(owners, 0o600);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL, enabled INTEGER NOT NULL, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, target_id TEXT NOT NULL,
        data TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS messages (channel TEXT NOT NULL, ts TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(channel,ts));
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS owners.bindings (target_id TEXT PRIMARY KEY, profile TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_run ON runs(job_id, target_id)
        WHERE status IN ('waiting','dispatching','submitted','uncertain','sending');`);
  }

  close() {
    this.db.close();
  }
  ownsTarget(id) {
    const owner = this.db
      .prepare('SELECT profile FROM owners.bindings WHERE target_id=?')
      .get(id)?.profile;
    return !owner || owner === this.profile;
  }
  bindTargets(targets) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const target of targets) {
        if (!this.ownsTarget(target.id))
          throw new Error('This session belongs to another Semi profile.');
        this.db
          .prepare('INSERT OR IGNORE INTO owners.bindings VALUES (?,?)')
          .run(target.id, this.profile);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
      ?.value;
  }
  setSetting(key, value) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES (?,?)')
      .run(key, value);
  }
  bindInstallation(config) {
    const key = `${config.teamId}:${config.ownerId}:${config.appId}`;
    const existing = this.setting('installation');
    if (existing && existing !== key)
      throw new Error(
        'This profile belongs to another Slack installation. Use a separate SEMI_PROFILE.',
      );
    this.setSetting('installation', key);
  }
  setDmChannel(channel) {
    const previous = this.setting('dmChannel');
    const destination = this.setting('defaultChannel');
    this.setSetting('dmChannel', channel);
    if (!destination || destination === previous)
      this.setSetting('defaultChannel', channel);
  }
  acquireRuntime() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pid = Number(this.setting('runtimePid'));
      if (pid) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
        }
        if (alive) throw new Error(`Semi is already running (PID ${pid}).`);
      }
      this.setSetting('runtimePid', String(process.pid));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  releaseRuntime() {
    this.db
      .prepare('DELETE FROM settings WHERE key=? AND value=?')
      .run('runtimePid', String(process.pid));
  }
  target(id) {
    const row = this.db.prepare('SELECT data FROM targets WHERE id=?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  putTarget(target) {
    this.db
      .prepare('INSERT OR REPLACE INTO targets VALUES (?,?)')
      .run(target.id, JSON.stringify(target));
  }
  jobs() {
    return this.db
      .prepare('SELECT * FROM jobs ORDER BY next_at')
      .all()
      .map((row) => ({
        ...JSON.parse(row.data),
        enabled: Boolean(row.enabled),
        nextAt: row.next_at,
      }));
  }
  job(id) {
    return this.jobs().find((job) => job.id === id);
  }
  saveJob(job, now = Date.now()) {
    this.bindTargets(job.targets);
    const id = job.id ?? randomUUID();
    const data = { ...job, id };
    this.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)')
      .run(
        id,
        JSON.stringify(data),
        job.enabled === false ? 0 : 1,
        now + job.minutes * 60000,
      );
    this.db
      .prepare(
        "UPDATE runs SET status='cancelled' WHERE job_id=? AND status='waiting'",
      )
      .run(id);
    return id;
  }
  toggleJob(id, enabled) {
    const job = this.job(id);
    if (!job) throw new Error('Unknown schedule.');
    this.db
      .prepare('UPDATE jobs SET enabled=?, next_at=? WHERE id=?')
      .run(enabled ? 1 : 0, Date.now() + job.minutes * 60000, id);
  }
  deleteJob(id) {
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    this.db
      .prepare(
        "UPDATE runs SET status='cancelled' WHERE job_id=? AND status='waiting'",
      )
      .run(id);
  }
  runs(jobId) {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE job_id=? ORDER BY created_at DESC LIMIT 50',
      )
      .all(jobId)
      .map((row) => ({ ...row, ...JSON.parse(row.data) }));
  }
  run(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    return row ? { ...row, ...JSON.parse(row.data) } : null;
  }
  waiting() {
    return this.db
      .prepare(
        "SELECT id FROM runs WHERE status='waiting' ORDER BY created_at, rowid",
      )
      .all()
      .map(({ id }) => this.run(id));
  }
  activeTarget(id) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM runs WHERE target_id=? AND status IN ('dispatching','submitted','uncertain','sending') LIMIT 1",
        )
        .get(id),
    );
  }
  messageRun(channel, ts) {
    const row = this.db
      .prepare('SELECT run_id FROM messages WHERE channel=? AND ts=?')
      .get(channel, ts);
    return row ? this.run(row.run_id) : null;
  }
  finishReport(id, receipt) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.transition(id, 'sending', 'reported', JSON.stringify(receipt)))
        throw new Error('Report status changed.');
      this.db
        .prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?)')
        .run(receipt.channel, receipt.ts, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  enqueueReply(eventId, original, prompt, threadTs, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare('INSERT OR IGNORE INTO events VALUES (?)')
        .run(eventId);
      if (!result.changes) {
        this.db.exec('COMMIT');
        return null;
      }
      const id = randomUUID();
      const data = {
        kind: 'reply',
        jobName: original.jobName,
        target: original.target,
        channel: original.channel,
        prompt,
        threadTs,
      };
      this.db
        .prepare("INSERT INTO runs VALUES (?,?,?,?, 'waiting',?,NULL)")
        .run(
          id,
          `reply:${eventId}`,
          original.target.id,
          JSON.stringify(data),
          now,
        );
      this.db
        .prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?)')
        .run(original.channel, threadTs, id);
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  transition(id, from, to, detail = '') {
    return (
      this.db
        .prepare('UPDATE runs SET status=?, detail=? WHERE id=? AND status=?')
        .run(to, detail, id, from).changes === 1
    );
  }
  resolve(id) {
    return (
      this.db
        .prepare(
          "UPDATE runs SET status='resolved' WHERE id=? AND status IN ('submitted','uncertain')",
        )
        .run(id).changes === 1
    );
  }
  claim(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = [];
      for (const job of this.jobs().filter(
        (item) => item.enabled && item.nextAt <= now,
      )) {
        this.db
          .prepare('UPDATE jobs SET next_at=? WHERE id=?')
          .run(now + job.minutes * 60000, job.id);
        for (const target of job.targets) {
          const id = randomUUID();
          const data = {
            jobName: job.name,
            prompt: job.prompt,
            target,
            channel:
              target.channel || job.channel || this.setting('defaultChannel'),
          };
          const result = this.db
            .prepare(
              "INSERT OR IGNORE INTO runs VALUES (?,?,?,?, 'waiting',?,NULL)",
            )
            .run(id, job.id, target.id, JSON.stringify(data), now);
          if (result.changes) claimed.push(this.run(id));
        }
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recover() {
    this.db.exec(
      "UPDATE runs SET status='uncertain', detail='Process ended before confirmation; inspect before resolving.' WHERE status IN ('dispatching','sending')",
    );
  }
}

export function validateJob(job) {
  if (!job.name?.trim() || job.name.length > 80)
    throw new Error('Name must be 1–80 characters.');
  if (
    !Number.isInteger(job.minutes) ||
    job.minutes < 1 ||
    job.minutes > 525600
  ) {
    throw new Error('Interval must be 1–525600 whole minutes.');
  }
  if (!job.prompt?.trim() || job.prompt.length > 8000)
    throw new Error('Prompt must be 1–8000 characters.');
  if (
    !Array.isArray(job.targets) ||
    !job.targets.length ||
    job.targets.length > 90
  ) {
    throw new Error('Select 1–90 sessions.');
  }
  if (
    new Set(job.targets.map((target) => target.id)).size !== job.targets.length
  )
    throw new Error('Duplicate session.');
  if (job.channel && !/^[CGD][A-Z0-9]+$/.test(job.channel))
    throw new Error('Invalid default channel.');
  for (const target of job.targets) {
    if (
      !['orca', 'cmux'].includes(target.provider) ||
      !['codex', 'claude'].includes(target.agent)
    ) {
      throw new Error('Unsupported terminal or agent.');
    }
    if (target.channel && !/^[CGD][A-Z0-9]+$/.test(target.channel))
      throw new Error('Invalid session channel.');
  }
}
