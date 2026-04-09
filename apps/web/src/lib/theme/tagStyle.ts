import type React from "react";

import { deterministicTagStyle } from "@/lib/theme/deterministicTagColor";

/**
 * Compute inline CSS properties for a ref tag badge using
 * deterministic color generation.
 *
 * Strips fully-qualified ref prefixes (`refs/heads/`, `refs/remotes/`)
 * and remote names so that the same logical branch always gets the
 * same color regardless of how it is referenced.
 */
export function tagStyle(
  ref: string,
  kind: "local" | "remote" = "local",
): React.CSSProperties {
  const trimmed = ref.trim();
  const stableKey = (() => {
    if (!trimmed) {
      return "default";
    }
    if (trimmed.startsWith("refs/heads/")) {
      return trimmed.slice("refs/heads/".length);
    }
    if (trimmed.startsWith("refs/remotes/")) {
      const remainder = trimmed.slice("refs/remotes/".length);
      const slashIndex = remainder.indexOf("/");
      return slashIndex === -1 ? remainder : remainder.slice(slashIndex + 1);
    }
    if (kind === "remote") {
      const slashIndex = trimmed.indexOf("/");
      if (slashIndex > 0) {
        return trimmed.slice(slashIndex + 1);
      }
    }
    return trimmed;
  })();

  return Object.fromEntries(
    deterministicTagStyle(stableKey, {
      profile: "balanced",
      surfaceVar: "--popover",
    })
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, value] = entry.split(":");
        return [key.trim(), value.trim()];
      }),
  ) as React.CSSProperties;
}
