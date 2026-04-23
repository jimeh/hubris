export type KeybindingWhenContext = Record<string, boolean | string | null>;

type Token =
  | { type: "and" | "bang" | "eq" | "lparen" | "neq" | "or" | "rparen" }
  | { type: "identifier" | "string"; value: string };

type Expression =
  | { key: string; type: "identifier" }
  | { type: "not"; value: Expression }
  | { left: Expression; type: "and" | "or"; right: Expression }
  | { key: string; type: "comparison"; value: string; operator: "==" | "!=" };

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
      value += input[index + 1];
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }

  throw new Error("Unterminated string in when condition");
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
