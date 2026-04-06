import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureMonaco, resetMonacoForTests } from "./monaco";

const { loaderConfig, monacoStub } = vi.hoisted(() => ({
  loaderConfig: vi.fn(),
  monacoStub: {
    editor: {
      defineTheme: vi.fn(),
      getModel: vi.fn(),
      setTheme: vi.fn(),
    },
  },
}));

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
    loaderConfig.mockReset();
    resetMonacoForTests();
  });

  it("configures the loader with the package-root Monaco instance", () => {
    configureMonaco();
    configureMonaco();

    expect(loaderConfig).toHaveBeenCalledTimes(1);
    expect(loaderConfig).toHaveBeenCalledWith({ monaco: monacoStub });
  });
});
