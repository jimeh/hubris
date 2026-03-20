import { describe, expect, it } from "vitest";
import { resolveMaterialFileIcon } from "./materialIconTheme";

describe("material icon theme resolver", () => {
  it("resolves html via language id fallback", () => {
    expect(resolveMaterialFileIcon("index.html", null).iconId).toBe("html");
  });

  it("resolves yaml extensions via language id fallback", () => {
    expect(resolveMaterialFileIcon("app.yaml", null).iconId).toBe("yaml");
    expect(resolveMaterialFileIcon("app.yml", null).iconId).toBe("yaml");
  });

  it("keeps specific filename matches ahead of generic yaml fallback", () => {
    expect(resolveMaterialFileIcon("docker-compose.yml", null).iconId).toBe(
      "docker",
    );
  });

  it("falls back to the generic file icon when nothing matches", () => {
    expect(resolveMaterialFileIcon("notes.foo", null).iconId).toBe("file");
  });
});
