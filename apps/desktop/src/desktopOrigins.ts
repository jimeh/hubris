/** Canonical desktop origins shared by the protocol, preload, and guards. */
export const HUBRIS_SCHEME = "https";
export const HUBRIS_HOST = "desktop.internal.hubris.build";
export const HUBRIS_VSCODE_CLI_HOST = `vscode-cli.${HUBRIS_HOST}`;
export const HUBRIS_CODE_SERVER_HOST = `code-server.${HUBRIS_HOST}`;
export const HUBRIS_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_HOST}`;
export const HUBRIS_WS_ORIGIN = `wss://${HUBRIS_HOST}`;
export const HUBRIS_VSCODE_CLI_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_VSCODE_CLI_HOST}`;
export const HUBRIS_CODE_SERVER_ORIGIN = `${HUBRIS_SCHEME}://${HUBRIS_CODE_SERVER_HOST}`;

/** Hostnames treated as trusted desktop-internal origins. */
export const HUBRIS_INTERNAL_HOSTS = [
  HUBRIS_HOST,
  HUBRIS_VSCODE_CLI_HOST,
  HUBRIS_CODE_SERVER_HOST,
] as const;
