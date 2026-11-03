import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function run(command, args, options = {}) {
  try {
    const { stdout } = await execute(command, args, {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `${command} failed (${error.code ?? 'timeout'}); delivery may be unconfirmed.`,
    );
  }
}

export async function runJson(command, args, options) {
  const value = JSON.parse(await run(command, args, options));
  if (value.ok === false)
    throw new Error(
      `${command}: ${value.error?.code ?? value.error ?? 'request_failed'}`,
    );
  return value;
}
