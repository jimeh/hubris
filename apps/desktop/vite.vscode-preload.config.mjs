import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
];

export default defineConfig({
  build: {
    outDir: ".vite/build",
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: "src/vscodePreload.ts",
      formats: ["cjs"],
      fileName: () => "vscodePreload.js",
    },
    rollupOptions: {
      external,
    },
  },
});
