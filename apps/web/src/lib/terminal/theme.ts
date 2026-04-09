export function getTerminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const get = (prop: string): string | undefined =>
    style.getPropertyValue(prop).trim() || undefined;

  return Object.fromEntries(
    Object.entries<string | undefined>({
      background: get("--terminal-background"),
      foreground: get("--terminal-foreground"),
      cursor: get("--terminal-cursor"),
      selectionBackground: get("--terminal-selection"),
      black: get("--terminal-ansi-black"),
      red: get("--terminal-ansi-red"),
      green: get("--terminal-ansi-green"),
      yellow: get("--terminal-ansi-yellow"),
      blue: get("--terminal-ansi-blue"),
      magenta: get("--terminal-ansi-magenta"),
      cyan: get("--terminal-ansi-cyan"),
      white: get("--terminal-ansi-white"),
      brightBlack: get("--terminal-ansi-bright-black"),
      brightRed: get("--terminal-ansi-bright-red"),
      brightGreen: get("--terminal-ansi-bright-green"),
      brightYellow: get("--terminal-ansi-bright-yellow"),
      brightBlue: get("--terminal-ansi-bright-blue"),
      brightMagenta: get("--terminal-ansi-bright-magenta"),
      brightCyan: get("--terminal-ansi-bright-cyan"),
      brightWhite: get("--terminal-ansi-bright-white"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
