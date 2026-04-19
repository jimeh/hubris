const path = require("node:path");
const { MakerZIP } = require("@electron-forge/maker-zip");
const { VitePlugin } = require("@electron-forge/plugin-vite");

function runtimeBinaryName(platform = process.platform) {
  return platform === "win32"
    ? "hubris-desktop-runtime.exe"
    : "hubris-desktop-runtime";
}

function runtimeResourcePath(platform = process.platform) {
  if (process.env.HUBRIS_DESKTOP_RUNTIME_PATH) {
    return path.resolve(process.env.HUBRIS_DESKTOP_RUNTIME_PATH);
  }

  return path.resolve(
    __dirname,
    "../../target/release",
    runtimeBinaryName(platform),
  );
}

module.exports = {
  outDir: path.resolve(__dirname, "../../dist"),
  packagerConfig: {
    name: "Hubris",
    executableName: "Hubris",
    icon: path.resolve(__dirname, "icons/icon"),
    overwrite: true,
    extraResource: [
      path.resolve(__dirname, "../web/dist"),
      runtimeResourcePath(),
    ],
  },
  makers: [new MakerZIP({}, ["darwin"])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.mjs",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mjs",
        },
        {
          entry: "src/vscodePreload.ts",
          config: "vite.vscode-preload.config.mjs",
        },
      ],
      renderer: [],
      concurrent: false,
    }),
  ],
};
