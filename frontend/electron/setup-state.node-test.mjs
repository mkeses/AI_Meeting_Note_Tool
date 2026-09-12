import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SETUP_PHASE,
  SetupStartupController,
  createSetupState,
  transitionSetupState,
} from './setup-state.mjs';

test('creates a safe initial setup state', () => {
  assert.deepEqual(createSetupState(), {
    phase: SETUP_PHASE.STARTING,
    message: 'Preparing the application...',
    progress: null,
    canRetry: false,
    canContinue: false,
  });
});

test('preserves genuine model provisioning progress only', () => {
  const provisioning = transitionSetupState(createSetupState(), {
    phase: SETUP_PHASE.PROVISIONING_LLM_MODEL,
    progress: 0.42,
  });
  const whisper = transitionSetupState(provisioning, {
    phase: SETUP_PHASE.PREPARING_TRANSCRIPTION_MODEL,
    progress: 2,
  });

  assert.equal(provisioning.progress, 0.42);
  assert.equal(whisper.progress, null);
  assert.equal(whisper.canRetry, false);
});

test('exposes retry and degraded continuation only for setup errors', () => {
  const state = transitionSetupState(createSetupState(), {
    phase: SETUP_PHASE.ERROR,
    message: 'The local AI model is unavailable.',
    canContinue: true,
  });

  assert.equal(state.canRetry, true);
  assert.equal(state.canContinue, true);
});

test('does not start duplicate setup attempts', async () => {
  let starts = 0;
  let finish;
  const events = [];
  const controller = new SetupStartupController({
    onStateChange: (state) => events.push(state.phase),
  });
  const run = () => {
    starts += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };

  const first = controller.start(run);
  const second = controller.start(run);

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(starts, 1);
  finish({ status: 'ready' });
  await first;
  assert.deepEqual(events, [SETUP_PHASE.STARTING]);
});
