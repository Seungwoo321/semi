import { readFileSync } from 'node:fs';
import { report } from './report.js';
import { postMessage } from './slack.js';
import { Store } from './store.js';
import { discover } from './terminals.js';

const [command, argument] = process.argv.slice(2);
let store;
try {
  if (command === 'send') {
    console.log(
      JSON.stringify(
        await postMessage(argument, readFileSync(0, 'utf8').trim()),
      ),
    );
  } else if (command === 'report') {
    store = new Store();
    console.log(
      JSON.stringify(await report(store, argument, readFileSync(0, 'utf8'))),
    );
  } else if (command === 'targets') {
    console.log(JSON.stringify(await discover(argument), null, 2));
  } else if (command === 'status') {
    store = new Store();
    console.log(
      JSON.stringify(argument ? store.runs(argument) : store.jobs(), null, 2),
    );
  } else {
    console.log(
      'Usage: node cli.js send CHANNEL < message.txt\n       node cli.js report RUN_ID < result.txt\n       node cli.js targets orca|cmux\n       node cli.js status [JOB_ID]',
    );
    if (command && command !== '--help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error.data?.error ?? error.message);
  process.exitCode = 1;
} finally {
  store?.close();
}
