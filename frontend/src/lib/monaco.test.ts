import { beforeEach, describe, expect, it, vi } from "vitest";

const loaderConfig = vi.fn();
const monacoStub = {
  editor: {
    defineTheme: vi.fn(),
    getModel: vi.fn(),
    setTheme: vi.fn(),
  },
};

const sideEffectImports: string[] = [];

vi.mock("@monaco-editor/react", () => ({
  loader: {
    config: (...args: unknown[]) => loaderConfig(...args),
  },
}));

vi.mock("monaco-editor/esm/vs/editor/editor.api", () => monacoStub);
vi.mock("monaco-editor/esm/vs/basic-languages/monaco.contribution.js", () => {
  sideEffectImports.push("basic");
  return {};
});
vi.mock("monaco-editor/esm/vs/language/css/monaco.contribution.js", () => {
  sideEffectImports.push("css");
  return {};
});
vi.mock("monaco-editor/esm/vs/language/html/monaco.contribution.js", () => {
  sideEffectImports.push("html");
  return {};
});
vi.mock("monaco-editor/esm/vs/language/json/monaco.contribution.js", () => {
  sideEffectImports.push("json");
  return {};
});
vi.mock(
  "monaco-editor/esm/vs/language/typescript/monaco.contribution.js",
  () => {
    sideEffectImports.push("typescript");
    return {};
  },
);

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class EditorWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class JsonWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({
  default: class CssWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({
  default: class HtmlWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class TsWorker {},
}));

describe("configureMonaco", () => {
  beforeEach(() => {
    vi.resetModules();
    loaderConfig.mockReset();
    sideEffectImports.length = 0;
  });

  it("loads Monaco language contributions before configuring the loader", async () => {
    const mod = await import("./monaco");

    expect(sideEffectImports).toEqual([
      "basic",
      "css",
      "html",
      "json",
      "typescript",
    ]);

    mod.configureMonaco();
    mod.configureMonaco();

    expect(loaderConfig).toHaveBeenCalledTimes(1);
    expect(loaderConfig).toHaveBeenCalledWith({ monaco: monacoStub });
  });
});
