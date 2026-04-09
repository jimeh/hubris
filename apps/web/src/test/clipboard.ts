/**
 * Consume mocked clipboard payloads so rejected Blob promises do not leak.
 */
export function consumeClipboardItems(items: unknown[]): void {
  for (const item of items) {
    if (!item || typeof item !== "object" || !("items" in item)) {
      continue;
    }

    for (const value of Object.values(
      (item as { items: Record<string, Promise<unknown> | unknown> }).items,
    )) {
      Promise.resolve(value).catch(() => {});
    }
  }
}
