import getHooks from '@slack/cli-hooks';

const hooks = getHooks();
hooks.hooks['get-manifest'] = 'node manifest.js';
console.log(JSON.stringify(hooks));
