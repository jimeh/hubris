import { describe, expect, it } from "vitest";
import {
  argsToFieldValues,
  canEditArgsWithFields,
  commandArgFieldsForCommand,
  fieldValuesToArgs,
} from "./args";

describe("command arg fields", () => {
  it("round-trips structured command args", () => {
    const fields = commandArgFieldsForCommand("tab.newBrowser");
    const values = argsToFieldValues(
      { paneId: "pane-1", url: "http://localhost:5173" },
      fields,
    );

    expect(values).toEqual({
      paneId: "pane-1",
      url: "http://localhost:5173",
    });
    expect(fieldValuesToArgs(fields, values)).toEqual({
      paneId: "pane-1",
      url: "http://localhost:5173",
    });
  });

  it("supports explicit false boolean args", () => {
    const fields = commandArgFieldsForCommand("project.remove");

    expect(
      fieldValuesToArgs(fields, {
        deleteManagedWorktrees: "false",
        force: "true",
      }),
    ).toEqual({
      deleteManagedWorktrees: false,
      force: true,
    });
  });

  it("falls back for unmodeled args", () => {
    const fields = commandArgFieldsForCommand("tab.newBrowser");

    expect(canEditArgsWithFields({ unknown: "value" }, fields)).toBe(false);
    expect(
      canEditArgsWithFields({ url: "http://localhost:5173" }, fields),
    ).toBe(true);
  });

  it("validates required args", () => {
    const fields = commandArgFieldsForCommand("settings.openSection");

    expect(() => fieldValuesToArgs(fields, {})).toThrow(/Section is required/);
  });
});
