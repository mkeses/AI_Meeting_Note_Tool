import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  DESKTOP_RENDERER_ORIGIN,
  resolveRendererAssetPath,
} from './desktop-protocol.mjs';

test('resolves desktop renderer assets below the bundled renderer directory', () => {
  assert.equal(
    resolveRendererAssetPath({
      requestUrl: `${DESKTOP_RENDERER_ORIGIN}/assets/index.js`,
      rendererDirectory: '/app/dist',
      pathApi: path.posix,
    }),
    '/app/dist/assets/index.js'
  );
});

test('rejects renderer paths that escape bundled assets', () => {
  assert.throws(
    () =>
      resolveRendererAssetPath({
        requestUrl: `${DESKTOP_RENDERER_ORIGIN}/..%5Csecrets.txt`,
        rendererDirectory: 'C:\\app\\dist',
        pathApi: path.win32,
      }),
    /escapes the bundled assets/
  );
});
