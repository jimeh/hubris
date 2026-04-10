import { describe, expect, it } from "vitest";

import { handleDesktopBootstrapRequest } from "../viteDesktopBootstrap";

describe("handleDesktopBootstrapRequest", () => {
  const bootstrapToken = "bootstrap-token";
  const sessionToken = "session-token";

  it("returns redirect headers for a valid bootstrap token", () => {
    const response = handleDesktopBootstrapRequest(
      `/_hubris/desktop/bootstrap?token=${bootstrapToken}`,
      bootstrapToken,
      sessionToken,
    );

    expect(response).toEqual({
      statusCode: 302,
      headers: {
        Location: "/",
        "Cache-Control": "no-store",
        "Set-Cookie":
          "hubris_desktop_session=session-token; Path=/; HttpOnly; SameSite=Strict",
      },
    });
  });

  it("rejects an invalid bootstrap token", () => {
    const response = handleDesktopBootstrapRequest(
      "/_hubris/desktop/bootstrap?token=wrong-token",
      bootstrapToken,
      sessionToken,
    );

    expect(response).toEqual({
      statusCode: 401,
      headers: {
        "Cache-Control": "no-store",
      },
      body: "unauthorized",
    });
  });

  it("allows repeated valid bootstrap requests in dev mode", () => {
    const firstResponse = handleDesktopBootstrapRequest(
      `/_hubris/desktop/bootstrap?token=${bootstrapToken}`,
      bootstrapToken,
      sessionToken,
    );
    const secondResponse = handleDesktopBootstrapRequest(
      `/_hubris/desktop/bootstrap?token=${bootstrapToken}`,
      bootstrapToken,
      sessionToken,
    );

    expect(firstResponse).toEqual(secondResponse);
    expect(secondResponse?.statusCode).toBe(302);
  });

  it("ignores unrelated requests", () => {
    expect(
      handleDesktopBootstrapRequest("/", bootstrapToken, sessionToken),
    ).toBeNull();
  });
});
