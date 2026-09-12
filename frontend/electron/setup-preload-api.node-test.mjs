import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createSetupBridge } = require('./setup-preload-api.cjs');

test('exposes only fixed setup IPC actions', async () => {
  const listeners = [];
  const invocations = [];
  const ipcRenderer = {
    on: (...arguments_) => listeners.push(arguments_),
    removeListener: (...arguments_) =>
      listeners.push(['remove', ...arguments_]),
    invoke: (channel) => {
      invocations.push(channel);
      return Promise.resolve({ accepted: true });
    },
  };

  const bridge = createSetupBridge(ipcRenderer);
  const received = [];
  const unsubscribe = bridge.subscribe((status) => received.push(status));

  assert.deepEqual(Object.keys(bridge), [
    'subscribe',
    'retry',
    'continueWithoutCleanup',
  ]);
  assert.equal(listeners[0][0], 'meeting-setup-status');
  listeners[0][1](undefined, { phase: 'starting' });
  assert.deepEqual(received, [{ phase: 'starting' }]);
  unsubscribe();
  assert.equal(listeners[1][0], 'remove');
  await bridge.retry();
  await bridge.continueWithoutCleanup();
  assert.deepEqual(invocations, [
    'meeting-setup-retry',
    'meeting-setup-continue',
  ]);
});

test('rejects non-function setup subscriptions', () => {
  const bridge = createSetupBridge({});
  assert.throws(() => bridge.subscribe(null), /callback/);
});
