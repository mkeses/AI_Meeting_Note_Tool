import path from 'node:path';

export const DESKTOP_RENDERER_SCHEME = 'meeting';
export const DESKTOP_RENDERER_HOST = 'renderer';
export const DESKTOP_RENDERER_ORIGIN = `${DESKTOP_RENDERER_SCHEME}://${DESKTOP_RENDERER_HOST}`;

export function resolveRendererAssetPath({
  requestUrl,
  rendererDirectory,
  pathApi = path,
}) {
  const url = new URL(requestUrl);

  if (
    url.protocol !== `${DESKTOP_RENDERER_SCHEME}:` ||
    url.host !== DESKTOP_RENDERER_HOST
  ) {
    throw new Error('Unexpected desktop renderer URL.');
  }

  const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const relativePath = requestedPath || 'index.html';
  const resolvedRendererDirectory = pathApi.resolve(rendererDirectory);
  const resolvedAssetPath = pathApi.resolve(
    resolvedRendererDirectory,
    relativePath
  );

  if (
    resolvedAssetPath !== resolvedRendererDirectory &&
    !resolvedAssetPath.startsWith(
      `${resolvedRendererDirectory}${pathApi.sep}`
    )
  ) {
    throw new Error('Desktop renderer URL escapes the bundled assets.');
  }

  return resolvedAssetPath;
}
