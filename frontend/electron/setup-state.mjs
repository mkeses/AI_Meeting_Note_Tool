export const SETUP_PHASE = Object.freeze({
  STARTING: 'starting',
  STARTING_OLLAMA: 'starting_ollama',
  PROVISIONING_LLM_MODEL: 'provisioning_llm_model',
  STARTING_BACKEND: 'starting_backend',
  PREPARING_TRANSCRIPTION_MODEL: 'preparing_transcription_model',
  READY: 'ready',
  ERROR: 'error',
});

const SETUP_MESSAGES = Object.freeze({
  [SETUP_PHASE.STARTING]: 'Preparing the application...',
  [SETUP_PHASE.STARTING_OLLAMA]: 'Starting local AI engine...',
  [SETUP_PHASE.PROVISIONING_LLM_MODEL]: 'Downloading AI model...',
  [SETUP_PHASE.STARTING_BACKEND]: 'Starting local services...',
  [SETUP_PHASE.PREPARING_TRANSCRIPTION_MODEL]:
    'Preparing transcription model...',
  [SETUP_PHASE.READY]: 'Setup complete. Opening AI Meeting Note Tool...',
  [SETUP_PHASE.ERROR]: "AI Meeting Note Tool couldn't finish setup.",
});

export function createSetupState(overrides = {}) {
  return {
    phase: SETUP_PHASE.STARTING,
    message: SETUP_MESSAGES[SETUP_PHASE.STARTING],
    progress: null,
    canRetry: false,
    canContinue: false,
    ...overrides,
  };
}

export function transitionSetupState(currentState, update) {
  if (!Object.values(SETUP_PHASE).includes(update.phase)) {
    throw new Error('Unsupported setup phase.');
  }

  const progress =
    typeof update.progress === 'number' &&
    Number.isFinite(update.progress) &&
    update.progress >= 0 &&
    update.progress <= 1
      ? update.progress
      : null;
  const isError = update.phase === SETUP_PHASE.ERROR;

  return {
    ...currentState,
    phase: update.phase,
    message: update.message ?? SETUP_MESSAGES[update.phase],
    progress,
    canRetry: isError,
    canContinue: isError && Boolean(update.canContinue),
  };
}

export class SetupStartupController {
  constructor({ onStateChange = () => {} } = {}) {
    this.onStateChange = onStateChange;
    this.state = createSetupState();
    this.startPromise = null;
  }

  update(update) {
    this.state = transitionSetupState(this.state, update);
    this.onStateChange(this.state);
    return this.state;
  }

  start(run) {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.update({ phase: SETUP_PHASE.STARTING });
    this.startPromise = Promise.resolve()
      .then(() => run((update) => this.update(update)))
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }
}
