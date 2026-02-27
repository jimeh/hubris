# Research: Frontend Setup & Node.js/PNPM Package Manager

## Runtime & Tooling Versions

Installed via mise (visible in paths):
- **Node.js**: v24.14.0 (`~/.local/share/mise/installs/node/24.14.0/`)
- **pnpm**: 10.30.3 (`~/.local/share/mise/installs/pnpm/10.30.3/`)

No `.nvmrc`, `.node-version`, `.tool-versions`, or `.npmrc` files exist.
No engine constraints in `package.json`. No pnpm workspace config
(`pnpm-workspace.yaml`) — this is a standalone package, not a workspace.

## package.json Anatomy

`frontend/package.json`:

```json
{
  "name": "frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module"
}
```

### Scripts

| Script    | Command                                                    |
|-----------|------------------------------------------------------------|
| `dev`     | `vite` (dev server on :5173)                               |
| `build`   | `vite build` (output to `frontend/dist/`)                  |
| `preview` | `vite preview`                                             |
| `check`   | `svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json` |
| `test`    | `vitest run`                                               |

### pnpm-Specific Config

```json
"pnpm": {
  "onlyBuiltDependencies": ["esbuild"]
}
```

`onlyBuiltDependencies` is a pnpm 9+ feature that restricts which packages
can run postinstall/install lifecycle scripts during `pnpm install`. Here
only `esbuild` is allowed (it has a postinstall that downloads its
platform-specific binary). All other packages with lifecycle scripts are
blocked. This is a security/performance feature.

### Dependencies (runtime)

All xterm.js related — browser-only, no Node.js APIs:

| Package                  | Version | Purpose                  |
|--------------------------|---------|--------------------------|
| `@xterm/xterm`           | ^6.0.0  | Terminal emulator core   |
| `@xterm/addon-fit`       | ^0.11.0 | Auto-resize to container |
| `@xterm/addon-web-links` | ^0.12.0 | Clickable URLs           |
| `@xterm/addon-webgl`     | ^0.19.0 | WebGL renderer (perf)    |

### devDependencies

| Package                        | Version  | Purpose                       |
|--------------------------------|----------|-------------------------------|
| `svelte`                       | ^5.45.2  | Component framework           |
| `@sveltejs/vite-plugin-svelte` | ^6.2.1   | Vite integration for Svelte   |
| `vite`                         | ^7.3.1   | Build tool / dev server       |
| `vitest`                       | ^4.0.18  | Test runner                   |
| `typescript`                   | ~5.9.3   | Type checking                 |
| `svelte-check`                 | ^4.3.4   | Svelte type checking          |
| `@tsconfig/svelte`             | ^5.0.6   | Base tsconfig for Svelte      |
| `@types/node`                  | ^24.10.1 | Node type definitions         |
| `tailwindcss`                  | ^4.2.1   | CSS framework                 |
| `@tailwindcss/vite`            | ^4.2.1   | Tailwind Vite plugin          |
| `tw-animate-css`               | ^1.4.0   | Tailwind animation utilities  |
| `bits-ui`                      | ^2.16.2  | Headless UI primitives        |
| `@internationalized/date`      | ^3.11.0  | Date handling (bits-ui dep)   |
| `@lucide/svelte`               | ^0.561.0 | Icon library                  |
| `clsx`                         | ^2.1.1   | Class name joining            |
| `tailwind-merge`               | ^3.5.0   | Tailwind class merging        |
| `tailwind-variants`            | ^3.2.2   | Variant-based class builder   |

## Lockfile

`frontend/pnpm-lock.yaml`:
- **Format**: lockfileVersion 9.0
- **Size**: 1713 lines
- **Settings**: `autoInstallPeers: true`, `excludeLinksFromLockfile: false`

### Native/Platform-Specific Packages

Three dependency trees include platform-specific native binaries:

1. **esbuild** (0.27.3) — used by Vite for JS/TS transformation
   - 20+ platform packages (`@esbuild/darwin-arm64`, etc.)
   - Listed in `pnpm.onlyBuiltDependencies` (allowed to run postinstall)

2. **rollup** (4.59.0) — used by Vite for production bundling
   - Platform packages (`@rollup/rollup-darwin-arm64`, etc.)

3. **lightningcss** (1.31.1) — used by Vite/Tailwind for CSS processing
   - 11 platform packages (`lightningcss-darwin-arm64`, etc.)

## Vite Configuration

`frontend/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
```

Key observations:
- **Only Node.js import**: `path from 'node:path'` — used solely for
  `path.resolve` in the `$lib` alias. This runs in Vite's Node.js
  process (config evaluation), not in browser code.
- **Proxy**: `/api` routes forwarded to Rust backend on :3001, including
  WebSocket upgrades (`ws: true`).
- **Plugins**: Svelte compilation + Tailwind CSS processing.

## TypeScript Configuration

Three-file setup (standard Vite scaffolding pattern):

### `tsconfig.json` (root solution file)
- Defines `$lib/*` path alias
- References `tsconfig.app.json` and `tsconfig.node.json`
- Contains no `compilerOptions` beyond paths and baseUrl

### `tsconfig.app.json` (browser code)
- Extends `@tsconfig/svelte/tsconfig.json`
- Target: ES2022, module: ESNext
- `allowJs: true`, `checkJs: true`, `moduleDetection: "force"`
- Types: `["svelte", "vite/client"]`
- Includes: `src/**/*.ts`, `src/**/*.js`, `src/**/*.svelte`
- Build info cache: `node_modules/.tmp/tsconfig.app.tsbuildinfo`

### `tsconfig.node.json` (Node-side tooling: vite.config.ts)
- Target: ES2023, strict mode
- Module resolution: bundler
- `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`
- Strict linting: `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`
- Includes only: `vite.config.ts`
- Build info cache: `node_modules/.tmp/tsconfig.node.tsbuildinfo`

## Svelte Configuration

`frontend/svelte.config.js`:
```javascript
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
export default {
  preprocess: vitePreprocess(),
}
```

Minimal — delegates preprocessing to Vite (handles TypeScript, CSS, etc.).

## shadcn-svelte Configuration

`frontend/components.json`:
```json
{
  "$schema": "https://shadcn-svelte.com/schema.json",
  "tailwind": { "css": "src/app.css", "baseColor": "slate" },
  "aliases": {
    "components": "$lib/components",
    "utils": "$lib/utils",
    "ui": "$lib/components/ui",
    "hooks": "$lib/hooks",
    "lib": "$lib"
  },
  "typescript": true,
  "registry": "https://shadcn-svelte.com/registry"
}
```

Used by `npx shadcn-svelte@latest add <component>` to generate component
files. The registry URL and aliases tell the CLI where to place generated
components.

## Entry Points

### `frontend/index.html`
- Mounts to `<div id="app">` with `class="h-screen"`
- Hardcoded `class="dark"` on `<html>`
- Loads `/src/main.ts` as ESM module

### `frontend/src/main.ts`
```typescript
import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
const app = mount(App, { target: document.getElementById('app')! });
export default app;
```

Uses Svelte 5's `mount()` API (not legacy `new App()`).

## CSS / Theming

`frontend/src/app.css`:
- Imports Tailwind v4 via `@import "tailwindcss"`
- Imports `tw-animate-css` for animations
- Custom dark variant: `@custom-variant dark (&:is(.dark *))`
- Defines CSS custom properties for light and dark themes (oklch color
  space)
- `@theme inline` block maps CSS vars to Tailwind tokens
- Base layer applies `border-border` and `bg-background text-foreground`

The xterm.js CSS is imported in `xterm.ts`:
```typescript
import '@xterm/xterm/css/xterm.css';
```

## Build Output & Production Serving

`vite build` outputs to `frontend/dist/`. The Rust backend serves this
directory in production via `tower_http::services::ServeDir` with SPA
fallback to `index.html` (`crates/server/src/lib.rs:44-51`):

```rust
let frontend_dist = PathBuf::from("frontend/dist");
if frontend_dist.is_dir() {
    let spa = ServeDir::new(&frontend_dist)
        .fallback(ServeFile::new(frontend_dist.join("index.html")));
    app = app.fallback_service(spa);
}
```

## Makefile Integration

All pnpm/Node.js invocations happen through the Makefile:

```makefile
build-frontend:
	cd frontend && pnpm install && pnpm build

check:
	cargo check
	cd frontend && pnpm check

clean:
	cargo clean
	rm -rf frontend/dist frontend/node_modules
```

`build-server` depends on `build-frontend`. The `dev` target just prints
instructions to run both servers manually in separate terminals.

## .gitignore

Root `.gitignore` explicitly ignores:
- `/frontend/node_modules/`
- `/frontend/dist/`

`frontend/.gitignore` (from Vite scaffold) also ignores:
- `node_modules`, `dist`, `dist-ssr`, `*.local`
- Log files: `npm-debug.log*`, `yarn-debug.log*`, `yarn-error.log*`,
  `pnpm-debug.log*`, `lerna-debug.log*`

## Node.js API Usage in Source Code

Scanned all `frontend/src/**/*.{ts,js,svelte}` for Node.js-specific APIs:

| API             | Found? | Location            | Context            |
|-----------------|--------|---------------------|--------------------|
| `node:*` import | Yes    | `vite.config.ts`    | Build config only  |
| `require()`     | No     | —                   | —                  |
| `process.*`     | No     | —                   | —                  |
| `__dirname`     | No     | —                   | —                  |
| `Buffer`        | No     | —                   | —                  |

**All browser-side source code is pure browser JS/TS with zero Node.js
API dependencies.** The only Node.js usage is in `vite.config.ts` (build
tooling).

## Test Setup

`frontend/src/lib/api.test.ts`:
- Uses vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`)
- Mocks browser globals (`location`, `fetch`) via `vi.stubGlobal`
- Dynamic import after mocking: `await import('./api')`
- No Node.js-specific test utilities
- No separate vitest config file — vitest picks up config from
  `vite.config.ts` automatically (via `@sveltejs/vite-plugin-svelte`
  integration)

## pnpm-Specific Behaviors

| Feature                   | Used? | Details                                   |
|---------------------------|-------|-------------------------------------------|
| Workspaces                | No    | No `pnpm-workspace.yaml`                  |
| `workspace:*` protocol    | No    | Single package                            |
| `onlyBuiltDependencies`   | Yes   | Restricts lifecycle scripts to esbuild    |
| `.npmrc` overrides         | No    | No `.npmrc` file                          |
| Content-addressable store | Yes   | Default pnpm behavior (symlinks)          |
| Catalog                   | No    | No `catalog:` specifiers                  |
| Patch/overrides           | No    | No `pnpm.overrides` or `pnpm.patchedDependencies` |

## Observations for Bun Migration Context

1. **No pnpm workspace features** — single package, no workspace
   protocol, no catalog. Clean migration surface.

2. **`pnpm.onlyBuiltDependencies`** — pnpm-specific. Bun equivalent is
   `trustedDependencies` in package.json (under the `bun` key) or
   `bunfig.toml`. Different semantics: pnpm blocks all except listed,
   Bun's `trustedDependencies` explicitly allows listed packages to run
   lifecycle scripts.

3. **Lockfile**: `pnpm-lock.yaml` (v9) → replaced by `bun.lock` (text
   format, default since Bun 1.2).

4. **Node.js API surface in app code**: Zero. Bun's `node:path`
   compatibility covers the only Node.js import (in vite.config.ts).

5. **Native binaries** (esbuild, rollup, lightningcss): Ship
   platform-specific optional deps. Bun handles these identically (reads
   `os` and `cpu` fields from package.json).

6. **node_modules layout**: pnpm uses content-addressable store with
   symlinks. Bun uses flat `node_modules` layout (closer to npm). No
   code depends on pnpm's symlink structure.

7. **`type: "module"`** — ESM-native, fully supported by Bun.

8. **`@types/node`** — Listed as devDependency. May want `@types/bun`
   instead (or alongside) for Bun-specific APIs, though not needed if
   only running Vite tooling.

9. **shadcn-svelte CLI** — Currently invoked via `npx`; with Bun
   becomes `bunx`. The `components.json` is runtime-agnostic.

10. **TypeScript build info** — cached in `node_modules/.tmp/`. Bun's
    `node_modules/` layout still supports this path.
