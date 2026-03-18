import { describe, expect, it } from "vitest";
import { selectPrepaintTheme } from "./prepaint";

const lightEntry = {
  isDark: false,
  vars: {
    "--background": "white",
  },
};

const darkEntry = {
  isDark: true,
  vars: {
    "--background": "black",
  },
};

describe("selectPrepaintTheme", () => {
  it("uses the dark cache entry for explicit dark mode", () => {
    const result = selectPrepaintTheme(
      JSON.stringify({
        settings: {
          appearance: {
            colorScheme: "dark",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
        },
      }),
      JSON.stringify({
        light: lightEntry,
        dark: darkEntry,
      }),
      false,
    );

    expect(result.wantDark).toBe(true);
    expect(result.entry).toEqual(darkEntry);
  });

  it("uses the light cache entry for explicit light mode", () => {
    const result = selectPrepaintTheme(
      JSON.stringify({
        settings: {
          appearance: {
            colorScheme: "light",
            lightTheme: "hubris-light",
            darkTheme: "hubris-dark",
          },
        },
      }),
      JSON.stringify({
        light: lightEntry,
        dark: darkEntry,
      }),
      true,
    );

    expect(result.wantDark).toBe(false);
    expect(result.entry).toEqual(lightEntry);
  });

  it("falls back to auto behavior when cached settings are missing", () => {
    const result = selectPrepaintTheme(
      null,
      JSON.stringify({
        light: lightEntry,
        dark: darkEntry,
      }),
      true,
    );

    expect(result.wantDark).toBe(true);
    expect(result.entry).toEqual(darkEntry);
  });

  it("falls back to auto behavior when cached settings are malformed", () => {
    const result = selectPrepaintTheme(
      "{bad json",
      JSON.stringify({
        light: lightEntry,
        dark: darkEntry,
      }),
      false,
    );

    expect(result.wantDark).toBe(false);
    expect(result.entry).toEqual(lightEntry);
  });
});
