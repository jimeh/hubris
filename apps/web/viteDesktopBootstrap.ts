const DESKTOP_BOOTSTRAP_PATH = "/_hubris/desktop/bootstrap";
const DESKTOP_SESSION_COOKIE_NAME = "hubris_desktop_session";

export type BootstrapResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
};

/**
 * Build the dev-only desktop bootstrap response for Vite-served Electron
 * sessions.
 */
export function handleDesktopBootstrapRequest(
  reqUrl: string | undefined,
  bootstrapToken: string,
  sessionToken: string,
): BootstrapResponse | null {
  const url = reqUrl ? new URL(reqUrl, "http://localhost") : null;
  if (!url || url.pathname !== DESKTOP_BOOTSTRAP_PATH) {
    return null;
  }

  if (url.searchParams.get("token") !== bootstrapToken) {
    return {
      statusCode: 401,
      headers: {
        "Cache-Control": "no-store",
      },
      body: "unauthorized",
    };
  }

  return {
    statusCode: 302,
    headers: {
      Location: "/",
      "Cache-Control": "no-store",
      "Set-Cookie": `${DESKTOP_SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`,
    },
  };
}
