/* Auto-generated from apps/desktop/src/desktopRuntimeConfigShared.ts — do not edit. */
/** Desktop-only runtime URLs exposed to the main Hubris renderer. */
export type DesktopRuntimeConfig = {
  apiBase: string;
  eventsUrl: string;
  terminalWsBase: string;
  vscodeBases: {
    codeServer: string;
    vscodeCli: string;
  };
};

declare global {
  interface Window {
    __HUBRIS_DESKTOP_CONFIG__?: DesktopRuntimeConfig;
  }
}
