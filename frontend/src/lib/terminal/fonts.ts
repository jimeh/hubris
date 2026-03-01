export interface BundledFont {
  id: string;
  name: string;
  family: string;
  regular: string;
  bold: string;
}

export const BUNDLED_FONTS: BundledFont[] = [
  {
    id: 'jetbrainsmono-nf',
    name: 'JetBrains Mono NF',
    family: 'JetBrainsMono NF',
    regular: '/fonts/JetBrainsMonoNerdFont-Regular.woff2',
    bold: '/fonts/JetBrainsMonoNerdFont-Bold.woff2',
  },
  {
    id: 'firacode-nf',
    name: 'FiraCode NF',
    family: 'FiraCode Nerd Font',
    regular: '/fonts/FiraCodeNerdFont-Regular.woff2',
    bold: '/fonts/FiraCodeNerdFont-Bold.woff2',
  },
  {
    id: 'hack-nf',
    name: 'Hack NF',
    family: 'Hack Nerd Font',
    regular: '/fonts/HackNerdFont-Regular.woff2',
    bold: '/fonts/HackNerdFont-Bold.woff2',
  },
  {
    id: 'meslolgs-nf',
    name: 'MesloLGS NF',
    family: 'MesloLGS Nerd Font',
    regular: '/fonts/MesloLGSNerdFont-Regular.woff2',
    bold: '/fonts/MesloLGSNerdFont-Bold.woff2',
  },
  {
    id: 'caskaydiamono-nf',
    name: 'CaskaydiaMono NF',
    family: 'CaskaydiaMono NF',
    regular: '/fonts/CaskaydiaMonoNerdFont-Regular.woff2',
    bold: '/fonts/CaskaydiaMonoNerdFont-Bold.woff2',
  },
  {
    id: 'geistmono-nf',
    name: 'GeistMono NF',
    family: 'GeistMono Nerd Font',
    regular: '/fonts/GeistMonoNerdFont-Regular.woff2',
    bold: '/fonts/GeistMonoNerdFont-Bold.woff2',
  },
  {
    id: 'commitmono-nf',
    name: 'CommitMono NF',
    family: 'CommitMono Nerd Font',
    regular: '/fonts/CommitMonoNerdFont-Regular.woff2',
    bold: '/fonts/CommitMonoNerdFont-Bold.woff2',
  },
  {
    id: '0xproto-nf',
    name: '0xProto NF',
    family: '0xProto Nerd Font',
    regular: '/fonts/0xProtoNerdFont-Regular.woff2',
    bold: '/fonts/0xProtoNerdFont-Bold.woff2',
  },
];

/**
 * Cross-platform monospace fallback chain.
 * Covers macOS (SF Mono, Menlo, Monaco), Windows (Cascadia Code,
 * Consolas), Linux (Liberation Mono, DejaVu Sans Mono), and
 * popular cross-platform installs.
 */
export const DEFAULT_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', " +
  "'Source Code Pro', 'SF Mono', Menlo, Monaco, " +
  "Consolas, 'Liberation Mono', 'DejaVu Sans Mono', " +
  "'Courier New', monospace";

const loadedFonts = new Set<string>();

/**
 * Inject @font-face for a bundled font and wait for the
 * browser to load it. Returns the CSS font-family name.
 * Idempotent — skips if already loaded.
 */
export async function loadBundledFont(id: string): Promise<string> {
  const font = BUNDLED_FONTS.find((f) => f.id === id);
  if (!font) throw new Error(`Unknown bundled font: ${id}`);
  if (loadedFonts.has(id)) return font.family;

  const style = document.createElement('style');
  style.id = `bundled-font-${id}`;
  style.textContent = `
    @font-face {
      font-family: '${font.family}';
      src: url('${font.regular}') format('woff2');
      font-weight: 400;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: '${font.family}';
      src: url('${font.bold}') format('woff2');
      font-weight: 700;
      font-style: normal;
      font-display: block;
    }
  `;
  document.head.appendChild(style);

  // Wait for browser to fetch and parse the font files
  await document.fonts.load(`400 16px '${font.family}'`);
  await document.fonts.load(`700 16px '${font.family}'`);

  loadedFonts.add(id);
  return font.family;
}

/**
 * Resolve TerminalSettings to a CSS font-family string.
 * For bundled fonts, loads @font-face first (async).
 */
export async function resolveFont(settings: {
  fontSource: string;
  systemFontFamily: string;
  bundledFont: string;
}): Promise<string> {
  switch (settings.fontSource) {
    case 'system':
      return settings.systemFontFamily || DEFAULT_FONT_FAMILY;
    case 'bundled': {
      try {
        const family = await loadBundledFont(settings.bundledFont);
        return `'${family}', monospace`;
      } catch {
        return DEFAULT_FONT_FAMILY;
      }
    }
    default:
      return DEFAULT_FONT_FAMILY;
  }
}
