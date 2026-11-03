import { postMessage, validateMessage } from './slack.js';

export async function report(store, id, body, send = postMessage) {
  const run = store.run(id);
  if (!run) throw new Error('Unknown report run.');
  if (!body.trim()) throw new Error('Report must not be empty.');
  const text = `[${run.jobName}] ${run.target.label}\n${body.trim()}`;
  validateMessage(run.channel, text);
  if (
    !['dispatching', 'submitted'].includes(run.status) ||
    !store.transition(run.id, run.status, 'sending')
  ) {
    throw new Error(
      'Report is already sent, unresolved, or cancelled. Inspect its status before retrying.',
    );
  }
  try {
    const result = await send(run.channel, text, { threadTs: run.threadTs });
    store.finishReport(run.id, result);
    return result;
  } catch (error) {
    store.transition(
      run.id,
      'sending',
      'uncertain',
      error.data?.error ?? error.message,
    );
    throw error;
  }
}
