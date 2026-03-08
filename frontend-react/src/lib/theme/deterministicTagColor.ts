import { converter, parse } from "culori";

const toOklch = converter("oklch");

export type DeterministicTagColorProfile = "subtle" | "balanced" | "vivid";

export interface DeterministicTagColorOptions {
  surfaceVar?: string;
  profile?: DeterministicTagColorProfile;
}

interface MixProfile {
  seedLightness: number;
  seedChroma: number;
  bgMix: number;
  borderMix: number;
  fgMix: number;
}

interface ToneProfile {
  darkSurface: MixProfile;
  lightSurface: MixProfile;
}

const DEFAULT_SURFACE_VAR = "--popover";
const FALLBACK_SURFACE_LIGHTNESS = 0.56;

const PROFILE_MAP: Record<DeterministicTagColorProfile, ToneProfile> = {
  subtle: {
    darkSurface: {
      seedLightness: 0.73,
      seedChroma: 0.09,
      bgMix: 20,
      borderMix: 38,
      fgMix: 48,
    },
    lightSurface: {
      seedLightness: 0.56,
      seedChroma: 0.08,
      bgMix: 13,
      borderMix: 28,
      fgMix: 42,
    },
  },
  balanced: {
    darkSurface: {
      seedLightness: 0.78,
      seedChroma: 0.12,
      bgMix: 26,
      borderMix: 48,
      fgMix: 58,
    },
    lightSurface: {
      seedLightness: 0.59,
      seedChroma: 0.11,
      bgMix: 18,
      borderMix: 36,
      fgMix: 52,
    },
  },
  vivid: {
    darkSurface: {
      seedLightness: 0.84,
      seedChroma: 0.16,
      bgMix: 33,
      borderMix: 57,
      fgMix: 66,
    },
    lightSurface: {
      seedLightness: 0.62,
      seedChroma: 0.15,
      bgMix: 24,
      borderMix: 44,
      fgMix: 60,
    },
  },
};

function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function surfaceLightness(surfaceVar: string): number {
  if (typeof document === "undefined") {
    return FALLBACK_SURFACE_LIGHTNESS;
  }

  const style = getComputedStyle(document.documentElement);
  const raw = style.getPropertyValue(surfaceVar).trim();
  if (!raw) {
    return FALLBACK_SURFACE_LIGHTNESS;
  }

  const parsed = parse(raw);
  if (!parsed) {
    return FALLBACK_SURFACE_LIGHTNESS;
  }

  const color = toOklch(parsed);
  if (!color || Number.isNaN(color.l)) {
    return FALLBACK_SURFACE_LIGHTNESS;
  }

  return Math.min(1, Math.max(0, color.l));
}

function profileFor(
  profile: DeterministicTagColorProfile,
  lightness: number,
): MixProfile {
  return lightness < 0.5
    ? PROFILE_MAP[profile].darkSurface
    : PROFILE_MAP[profile].lightSurface;
}

export function deterministicTagStyle(
  key: string,
  options: DeterministicTagColorOptions = {},
): string {
  const surfaceVar = options.surfaceVar ?? DEFAULT_SURFACE_VAR;
  const profile = options.profile ?? "balanced";
  const stableKey = key.trim().toLowerCase() || "default";
  const hue = fnv1aHash(stableKey) % 360;
  const surfaceL = surfaceLightness(surfaceVar);
  const tone = profileFor(profile, surfaceL);

  return [
    `--tag-seed: oklch(${tone.seedLightness} ${tone.seedChroma} ${hue})`,
    `--tag-bg-mix: ${tone.bgMix}`,
    `--tag-border-mix: ${tone.borderMix}`,
    `--tag-fg-mix: ${tone.fgMix}`,
  ].join("; ");
}
