/// <reference types="vite/client" />

interface Window {
  readonly meetingDesktop?: {
    readonly backendOrigin: string;
  };
}

// CSS Modules
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
