function getRequestOrigin(requestUrl) {
  try {
    const url = new URL(requestUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function isTrustedRendererRequest(requestUrl, rendererOrigin) {
  return getRequestOrigin(requestUrl) === rendererOrigin;
}

function getDiagnosticRequestUrl(requestUrl) {
  if (!requestUrl) {
    return null;
  }

  try {
    const url = new URL(requestUrl);

    if (url.protocol === 'file:') {
      return 'file://[redacted]';
    }

    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[unparseable]';
  }
}

function logDesktopMediaDiagnostic(event, details) {
  console.info(`[desktop-media] ${event}`, details);
}

function isAudioOrUnspecifiedMediaRequest(permission, details) {
  const hasOnlyAudio =
    details.mediaTypes?.includes('audio') === true &&
    details.mediaTypes?.includes('video') !== true;
  // Electron reports trusted display-capture approval as `media` without a
  // media classification. Explicit video requests remain denied.
  const hasUnspecifiedMediaType =
    Array.isArray(details.mediaTypes) &&
    details.mediaTypes.length === 0 &&
    details.mediaType == null;

  return (
    permission === 'media' &&
    (hasOnlyAudio || hasUnspecifiedMediaType)
  );
}

function isAllowedDisplayCaptureRequest(permission, details, rendererOrigin) {
  return (
    permission === 'display-capture' &&
    isTrustedRendererRequest(details.requestingUrl, rendererOrigin)
  );
}

function isTrustedPermissionCheck(requestingOrigin, details, rendererOrigin) {
  return (
    requestingOrigin === rendererOrigin ||
    isTrustedRendererRequest(details.requestingUrl ?? '', rendererOrigin)
  );
}

/**
 * Configure desktop media access for the one trusted Electron renderer.
 * Windows loopback audio is selected only for an explicit, user-initiated
 * getDisplayMedia request from that renderer.
 */
export function configureDesktopMediaCapture({
  session,
  desktopCapturer,
  rendererOrigin,
  platform,
}) {
  session.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      const trustedOrigin = isTrustedPermissionCheck(
        requestingOrigin,
        details,
        rendererOrigin
      );
      const allowed =
        (permission === 'display-capture' && trustedOrigin) ||
        (permission === 'media' &&
          details.mediaType === 'audio' &&
          trustedOrigin);

      logDesktopMediaDiagnostic('permission-check', {
        permission,
        requestingOrigin: getRequestOrigin(requestingOrigin),
        requestingUrl: getDiagnosticRequestUrl(details.requestingUrl),
        mediaType: details.mediaType ?? null,
        trustedOrigin,
        allowed,
      });

      return allowed;
    }
  );

  session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const trustedOrigin = isTrustedRendererRequest(
        details.requestingUrl,
        rendererOrigin
      );
      const allowMedia =
        isAudioOrUnspecifiedMediaRequest(permission, details) &&
        trustedOrigin;
      const allowDisplayCapture = isAllowedDisplayCaptureRequest(
        permission,
        details,
        rendererOrigin
      );
      const allowed = allowMedia || allowDisplayCapture;

      logDesktopMediaDiagnostic('permission-request', {
        permission,
        requestingUrl: getDiagnosticRequestUrl(details.requestingUrl),
        mediaTypes: details.mediaTypes ?? null,
        mediaType: details.mediaType ?? null,
        trustedOrigin,
        allowed,
      });

      callback(allowed);
    }
  );

  session.setDisplayMediaRequestHandler((request, callback) => {
    const trustedOrigin = isTrustedRendererRequest(
      request.securityOrigin,
      rendererOrigin
    );
    const getSourcesReached =
      platform === 'win32' &&
      request.userGesture &&
      request.videoRequested &&
      trustedOrigin;

    logDesktopMediaDiagnostic('display-request', {
      securityOrigin: getRequestOrigin(request.securityOrigin),
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture,
      platform,
      trustedOrigin,
      getSourcesReached,
    });

    const respond = (streams) => {
      logDesktopMediaDiagnostic('display-response', {
        callbackInvoked: true,
        grantedVideo: Boolean(streams.video),
        grantedAudio: Boolean(streams.audio),
      });
      callback(streams);
    };

    if (!getSourcesReached) {
      respond({});
      return;
    }

    void desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => {
        logDesktopMediaDiagnostic('display-sources', {
          getSourcesReached: true,
          screenSourceCount: sources.length,
        });

        const screen = sources[0];

        if (!screen) {
          respond({});
          return;
        }

        respond({
          video: screen,
          ...(request.audioRequested ? { audio: 'loopback' } : {}),
        });
      })
      .catch(() => {
        logDesktopMediaDiagnostic('display-sources-failed', {
          getSourcesReached: true,
        });
        respond({});
      });
  });
}
