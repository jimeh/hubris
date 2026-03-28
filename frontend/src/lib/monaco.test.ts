import { beforeEach, describe, expect, it, vi } from "vitest";

const loaderConfig = vi.fn();
const monacoStub = {
  editor: {
    defineTheme: vi.fn(),
    getModel: vi.fn(),
    setTheme: vi.fn(),
  },
  languages: {
    getLanguages: vi.fn(() => [{ id: "json" }, { id: "rust" }]),
  },
};

vi.mock("@monaco-editor/react", () => ({
  loader: {
    config: (...args: unknown[]) => loaderConfig(...args),
  },
}));

vi.mock("monaco-editor", () => monacoStub);

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
    vi.mocked(monacoStub.languages.getLanguages).mockClear();
  });

  it("configures the loader with the package-root Monaco instance", async () => {
    const mod = await import("./monaco");

    mod.configureMonaco();
    mod.configureMonaco();

    expect(loaderConfig).toHaveBeenCalledTimes(1);
    expect(loaderConfig).toHaveBeenCalledWith({ monaco: monacoStub });
  });

  it("uses a Monaco instance that already includes basic languages", async () => {
    await import("./monaco");

    const languages = monacoStub.languages
      .getLanguages()
      .map((lang) => lang.id);

    expect(monacoStub.languages.getLanguages).toHaveBeenCalled();
    expect(languages).toContain("json");
    expect(languages).toContain("rust");
  });
});
