export function shouldFlushBufferedInputAfterResize(
  sentResize: boolean,
  hasBufferedInput: boolean,
): boolean {
  return sentResize && hasBufferedInput;
}

export function shouldKeepBufferedInputQueued(
  sentResize: boolean,
  hasBufferedInput: boolean,
): boolean {
  return !sentResize && hasBufferedInput;
}
