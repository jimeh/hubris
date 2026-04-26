export type KeybindingWhenContext = Record<string, boolean | string | null>;

export type WhenConditionCompletion = {
  description: string;
  value: string;
};

export const knownWhenConditionKeys = [
  "activeTabPreview",
  "activeTabType",
  "browserFocus",
  "commandPaletteOpen",
  "dialogOpen",
  "editorFocus",
  "focusedPane",
  "gitStatusFocus",
  "inputFocus",
  "isLinux",
  "isMacOS",
  "isWindows",
  "selectedProject",
  "selectedWorktree",
  "terminalFocus",
] as const;

const knownWhenConditionKeySet = new Set<string>(knownWhenConditionKeys);

export const whenConditionCompletions = [
  { description: "A preview tab is active", value: "activeTabPreview" },
  { description: "The active tab is a browser", value: "browserFocus" },
  { description: "The command palette is open", value: "commandPaletteOpen" },
  { description: "A command-owned dialog is open", value: "dialogOpen" },
  { description: "The active tab is an editor", value: "editorFocus" },
  { description: "A pane is focused", value: "focusedPane" },
  { description: "Git status or sidebar has focus", value: "gitStatusFocus" },
  {
    description: "Text input or editable element has focus",
    value: "inputFocus",
  },
  { description: "The client is Linux", value: "isLinux" },
  { description: "The client is macOS", value: "isMacOS" },
  { description: "The client is Windows", value: "isWindows" },
  { description: "A project is selected", value: "selectedProject" },
  { description: "A worktree is selected", value: "selectedWorktree" },
  { description: "The active terminal has focus", value: "terminalFocus" },
  {
    description: "Active tab is terminal",
    value: "activeTabType == 'terminal'",
  },
  {
    description: "Active tab is browser",
    value: "activeTabType == 'browser'",
  },
  {
    description: "Active tab is file editor",
    value: "activeTabType == 'file'",
  },
  {
    description: "Active tab is git diff",
    value: "activeTabType == 'git_diff'",
  },
] as const satisfies readonly WhenConditionCompletion[];

export function completeWhenExpression(input: {
  completion: string;
  cursorIndex: number;
  value: string;
}): { cursorIndex: number; value: string } {
  const token = currentWhenToken(input.value, input.cursorIndex);
  const nextValue =
    input.value.slice(0, token.start) +
    input.completion +
    input.value.slice(input.cursorIndex);
  return {
    cursorIndex: token.start + input.completion.length,
    value: nextValue,
  };
}

export function matchingWhenCompletions(
  value: string,
  cursorIndex: number,
): WhenConditionCompletion[] {
  const token = currentWhenToken(value, cursorIndex);
  if (!token.value) {
    return [];
  }
  const needle = token.value.toLowerCase();
  return whenConditionCompletions
    .filter((completion) => {
      const value = completion.value.toLowerCase();
      return value.includes(needle) && value !== needle;
    })
    .slice(0, 8);
}

export type WhenHighlightToken = {
  type:
    | "invalid"
    | "key"
    | "operator"
    | "paren"
    | "string"
    | "unknown"
    | "whitespace";
  value: string;
};

export function tokenizeWhenExpressionForHighlighting(
  expression: string,
): WhenHighlightToken[] {
  const tokens: WhenHighlightToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];
    const whitespace = /^\s+/.exec(expression.slice(index));
    if (whitespace) {
      tokens.push({ type: "whitespace", value: whitespace[0] });
      index += whitespace[0].length;
      continue;
    }

    const operator = readHighlightOperator(expression, index);
    if (operator) {
      tokens.push({ type: "operator", value: operator });
      index += operator.length;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const [value, nextIndex, closed] = readHighlightString(
        expression,
        index,
        char,
      );
      tokens.push({ type: closed ? "string" : "invalid", value });
      index = nextIndex;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(
      expression.slice(index),
    );
    if (identifier) {
      tokens.push({
        type: knownWhenConditionKeySet.has(identifier[0]) ? "key" : "unknown",
        value: identifier[0],
      });
      index += identifier[0].length;
      continue;
    }

    tokens.push({ type: "invalid", value: char });
    index += 1;
  }

  return tokens;
}

function readHighlightOperator(
  expression: string,
  index: number,
): string | null {
  for (const operator of ["&&", "||", "==", "!=", "!"]) {
    if (expression.startsWith(operator, index)) {
      return operator;
    }
  }
  return null;
}

function readHighlightString(
  input: string,
  start: number,
  quote: string,
): [string, number, boolean] {
  let value = quote;
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    value += char;
    index += 1;
    if (char === "\\" && index < input.length) {
      value += input[index];
      index += 1;
      continue;
    }
    if (char === quote) {
      return [value, index, true];
    }
  }

  return [value, index, false];
}

export function normalizeWhenExpressionWhitespace(
  expression: string | null | undefined,
): string | undefined {
  if (!expression?.trim()) {
    return undefined;
  }

  let normalized = "";
  let pendingWhitespace = false;
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      pendingWhitespace = normalized.length > 0;
      index += 1;
      continue;
    }

    if (pendingWhitespace) {
      normalized += " ";
      pendingWhitespace = false;
    }

    if (char === "'" || char === '"') {
      const [literal, nextIndex] = readStringLiteral(expression, index, char);
      normalized += literal;
      index = nextIndex;
      continue;
    }

    normalized += char;
    index += 1;
  }

  return normalized.trim() || undefined;
}

function readStringLiteral(
  input: string,
  start: number,
  quote: string,
): [string, number] {
  let literal = quote;
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    literal += char;
    index += 1;
    if (char === "\\" && index < input.length) {
      literal += input[index];
      index += 1;
      continue;
    }
    if (char === quote) {
      return [literal, index];
    }
  }

  return [literal, index];
}

type Token =
  | { type: "and" | "bang" | "eq" | "lparen" | "neq" | "or" | "rparen" }
  | { type: "identifier" | "string"; value: string };

type Expression =
  | { key: string; type: "identifier" }
  | { type: "not"; value: Expression }
  | { left: Expression; type: "and" | "or"; right: Expression }
  | { key: string; type: "comparison"; value: string; operator: "==" | "!=" };

function currentWhenToken(
  value: string,
  cursorIndex: number,
): { start: number; value: string } {
  const beforeCursor = value.slice(0, cursorIndex);
  const match = /[A-Za-z_][A-Za-z0-9_.-]*$/.exec(beforeCursor);
  if (!match) {
    return { start: cursorIndex, value: "" };
  }
  return {
    start: cursorIndex - match[0].length,
    value: match[0],
  };
}

export function evaluateWhenExpression(
  expression: string | undefined,
  context: KeybindingWhenContext,
): boolean {
  if (!expression?.trim()) {
    return true;
  }

  const parser = new Parser(tokenize(expression));
  const parsed = parser.parseExpression();
  parser.expectEnd();
  return evaluateExpression(parsed, context);
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (input.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (input.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (input.startsWith("==", index)) {
      tokens.push({ type: "eq" });
      index += 2;
      continue;
    }
    if (input.startsWith("!=", index)) {
      tokens.push({ type: "neq" });
      index += 2;
      continue;
    }
    if (char === "!") {
      tokens.push({ type: "bang" });
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const [value, nextIndex] = readString(input, index, char);
      tokens.push({ type: "string", value });
      index = nextIndex;
      continue;
    }

    const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(input.slice(index));
    if (!match) {
      throw new Error(
        `Unexpected token in when condition near "${input.slice(index)}"`,
      );
    }
    tokens.push({ type: "identifier", value: match[0] });
    index += match[0].length;
  }

  return tokens;
}

function readString(
  input: string,
  start: number,
  quote: string,
): [string, number] {
  let value = "";
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === quote) {
      return [value, index + 1];
    }
    if (char === "\\" && index + 1 < input.length) {
      const [escaped, nextIndex] = readEscape(input, index);
      value += escaped;
      index = nextIndex;
      continue;
    }
    value += char;
    index += 1;
  }

  throw new Error("Unterminated string in when condition");
}

function readEscape(input: string, start: number): [string, number] {
  const char = input[start + 1];
  if (!char) {
    throw new Error("Invalid escape in when condition string");
  }

  switch (char) {
    case "\\":
    case '"':
    case "'":
      return [char, start + 2];
    case "b":
      return ["\b", start + 2];
    case "f":
      return ["\f", start + 2];
    case "n":
      return ["\n", start + 2];
    case "r":
      return ["\r", start + 2];
    case "t":
      return ["\t", start + 2];
    case "u": {
      const hex = input.slice(start + 2, start + 6);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
        throw new Error("Invalid unicode escape in when condition string");
      }
      return [String.fromCharCode(Number.parseInt(hex, 16)), start + 6];
    }
    default:
      throw new Error(`Invalid escape "\\${char}" in when condition string`);
  }
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseExpression(): Expression {
    return this.parseOr();
  }

  expectEnd(): void {
    if (this.peek()) {
      throw new Error("Unexpected trailing token in when condition");
    }
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    while (this.consume("or")) {
      left = { left, type: "or", right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseUnary();
    while (this.consume("and")) {
      left = { left, type: "and", right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (this.consume("bang")) {
      return { type: "not", value: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    if (this.consume("lparen")) {
      const value = this.parseExpression();
      if (!this.consume("rparen")) {
        throw new Error("Missing closing parenthesis in when condition");
      }
      return value;
    }

    const identifier = this.consumeValue("identifier");
    if (!identifier) {
      throw new Error("Expected identifier in when condition");
    }

    const operator = this.consume("eq")
      ? "=="
      : this.consume("neq")
        ? "!="
        : null;
    if (!operator) {
      return { key: identifier, type: "identifier" };
    }

    const value =
      this.consumeValue("string") ??
      this.consumeValue("identifier") ??
      (() => {
        throw new Error("Expected comparison value in when condition");
      })();

    return { key: identifier, operator, type: "comparison", value };
  }

  private consume(type: Token["type"]): boolean {
    if (this.peek()?.type !== type) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private consumeValue(type: "identifier" | "string"): string | null {
    const token = this.peek();
    if (token?.type !== type) {
      return null;
    }
    this.index += 1;
    return token.value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

function evaluateExpression(
  expression: Expression,
  context: KeybindingWhenContext,
): boolean {
  switch (expression.type) {
    case "identifier":
      return readBooleanContext(expression.key, context);
    case "not":
      return !evaluateExpression(expression.value, context);
    case "and":
      return (
        evaluateExpression(expression.left, context) &&
        evaluateExpression(expression.right, context)
      );
    case "or":
      return (
        evaluateExpression(expression.left, context) ||
        evaluateExpression(expression.right, context)
      );
    case "comparison": {
      const actual = readContext(expression.key, context);
      const matches = actual === expression.value;
      return expression.operator === "==" ? matches : !matches;
    }
  }
}

function readBooleanContext(
  key: string,
  context: KeybindingWhenContext,
): boolean {
  const value = readContext(key, context);
  if (typeof value !== "boolean") {
    throw new Error(`When condition key "${key}" is not boolean`);
  }
  return value;
}

function readContext(
  key: string,
  context: KeybindingWhenContext,
): boolean | string | null {
  if (!(key in context)) {
    throw new Error(`Unknown when condition key "${key}"`);
  }
  return context[key];
}
