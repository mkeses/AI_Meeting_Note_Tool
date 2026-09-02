import assert from 'node:assert/strict';
import test from 'node:test';
import { configureDesktopMediaCapture } from './desktop-media.mjs';

const RENDERER_ORIGIN = 'meeting://renderer';
const RENDERER_URL = `${RENDERER_ORIGIN}/index.html`;

function createSession() {
  return {
    setPermissionCheckHandler(handler) {
      this.permissionCheckHandler = handler;
    },
    setPermissionRequestHandler(handler) {
      this.permissionRequestHandler = handler;
    },
    setDisplayMediaRequestHandler(handler) {
      this.displayMediaRequestHandler = handler;
    },
  };
}

function configure({
  sources = [{ id: 'screen:1' }],
  platform = 'win32',
} = {}) {
  const session = createSession();
  const desktopCapturer = {
    getSources: async (options) => {
      assert.deepEqual(options, { types: ['screen'] });
      return sources;
    },
  };

  configureDesktopMediaCapture({
    session,
    desktopCapturer,
    rendererOrigin: RENDERER_ORIGIN,
    platform,
  });

  return session;
}

test('permits only trusted microphone and display-capture permission checks', () => {
  const session = configure();

  assert.equal(
    session.permissionCheckHandler(null, 'media', RENDERER_ORIGIN, {
      mediaType: 'audio',
      requestingUrl: RENDERER_URL,
    }),
    true
  );
  assert.equal(
    session.permissionCheckHandler(null, 'media', RENDERER_ORIGIN, {
      mediaType: 'video',
      requestingUrl: RENDERER_URL,
    }),
    false
  );
  assert.equal(
    session.permissionCheckHandler(null, 'media', 'https://untrusted.example', {
      mediaType: 'audio',
      requestingUrl: 'https://untrusted.example/',
    }),
    false
  );
  assert.equal(
    session.permissionCheckHandler(null, 'display-capture', RENDERER_ORIGIN, {
      requestingUrl: RENDERER_URL,
    }),
    true
  );
  assert.equal(
    session.permissionCheckHandler(
      null,
      'display-capture',
      'https://untrusted.example',
      { requestingUrl: 'https://untrusted.example/' }
    ),
    false
  );
});

test('permits only trusted microphone and display-capture permission requests', () => {
  const session = configure();
  const requestPermission = (permission, details) => {
    let allowed;
    session.permissionRequestHandler(
      null,
      permission,
      (value) => {
        allowed = value;
      },
      details
    );
    return allowed;
  };

  assert.equal(
    requestPermission('media', {
      requestingUrl: RENDERER_URL,
      mediaTypes: ['audio'],
    }),
    true
  );
  assert.equal(
    requestPermission('media', {
      requestingUrl: RENDERER_URL,
      mediaTypes: [],
      mediaType: null,
    }),
    true
  );
  assert.equal(
    requestPermission('display-capture', { requestingUrl: RENDERER_URL }),
    true
  );
  assert.equal(
    requestPermission('media', {
      requestingUrl: RENDERER_URL,
      mediaTypes: ['video'],
    }),
    false
  );
  assert.equal(
    requestPermission('media', {
      requestingUrl: RENDERER_URL,
      mediaTypes: ['audio', 'video'],
    }),
    false
  );
  assert.equal(
    requestPermission('media', {
      requestingUrl: 'https://untrusted.example/',
      mediaTypes: [],
      mediaType: null,
    }),
    false
  );
  assert.equal(
    requestPermission('display-capture', {
      requestingUrl: 'https://untrusted.example/',
    }),
    false
  );
});

test('selects a Windows screen source with loopback system audio', async () => {
  const session = configure();
  let streams;

  session.displayMediaRequestHandler(
    {
      securityOrigin: RENDERER_ORIGIN,
      userGesture: true,
      videoRequested: true,
      audioRequested: true,
    },
    (value) => {
      streams = value;
    }
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(streams, {
    video: { id: 'screen:1' },
    audio: 'loopback',
  });
});

test('denies untrusted, non-user-initiated, and non-Windows display capture', () => {
  const session = configure();

  for (const request of [
    {
      securityOrigin: 'https://untrusted.example',
      userGesture: true,
      videoRequested: true,
      audioRequested: true,
    },
    {
      securityOrigin: RENDERER_ORIGIN,
      userGesture: false,
      videoRequested: true,
      audioRequested: true,
    },
  ]) {
    let streams;
    session.displayMediaRequestHandler(request, (value) => {
      streams = value;
    });
    assert.deepEqual(streams, {});
  }

  const nonWindowsSession = configure({ platform: 'linux' });
  let streams;
  nonWindowsSession.displayMediaRequestHandler(
    {
      securityOrigin: RENDERER_ORIGIN,
      userGesture: true,
      videoRequested: true,
      audioRequested: true,
    },
    (value) => {
      streams = value;
    }
  );

  assert.deepEqual(streams, {});
});
