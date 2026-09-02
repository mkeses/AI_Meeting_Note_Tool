export function shouldRegisterPwa(
  isProduction: boolean,
  protocol: string,
  serviceWorkerSupported: boolean
): boolean {
  return (
    isProduction &&
    serviceWorkerSupported &&
    (protocol === 'http:' || protocol === 'https:')
  );
}

export function registerPwa(): void {
  if (
    !shouldRegisterPwa(
      import.meta.env.PROD,
      window.location.protocol,
      'serviceWorker' in navigator
    )
  ) {
    return;
  }

  void navigator.serviceWorker.register(
    `${import.meta.env.BASE_URL}service-worker.js`
  );
}
