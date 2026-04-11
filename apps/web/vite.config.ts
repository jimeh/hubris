import path from "node:path";
import fs from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { handleDesktopBootstrapRequest } from "./viteDesktopBootstrap";

const devId = process.env.HUBRIS_DEV_ID;
const devTmp = process.env.HUBRIS_DEV_TMP;
const desktopBootstrapToken = process.env.HUBRIS_DESKTOP_BOOTSTRAP_TOKEN;
const desktopSessionToken = process.env.HUBRIS_DESKTOP_SESSION_TOKEN;
const isVitest = process.env.VITEST === "true";
const isVitestSmoke = process.env.HUBRIS_VITEST_SMOKE === "true";
const isDesktopDev = Boolean(
  devId && devTmp && desktopBootstrapToken && desktopSessionToken,
);
const desktopDevHost = "desktop.internal.hubris.build";

async function waitForBackendState(
  timeoutMs = 120_000,
): Promise<{ pid: number; port: number } | null> {
  if (!devId || !devTmp) return null;

  const stateFile = path.join(devTmp, `dev-${devId}.backend.json`);
  const start = Date.now();

  console.log("Waiting for backend...");
  while (Date.now() - start < timeoutMs) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      if (data.port) return data;
    } catch {
      // File does not exist yet or is incomplete.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Backend did not start within timeout");
}

function devInstancePlugin(): Plugin {
  return {
    name: "hubris-dev-instance",
    configureServer(server) {
      if (desktopBootstrapToken && desktopSessionToken) {
        server.middlewares.use((req, res, next) => {
          const response = handleDesktopBootstrapRequest(
            req.url,
            desktopBootstrapToken,
            desktopSessionToken,
          );
          if (!response) {
            next();
            return;
          }

          res.statusCode = response.statusCode;
          for (const [name, value] of Object.entries(response.headers)) {
            res.setHeader(name, value);
          }
          res.end(response.body);
        });
      }

      if (!devId || !devTmp) return;

      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        if (typeof addr === "object" && addr) {
          fs.writeFileSync(
            path.join(devTmp, `dev-${devId}.frontend.json`),
            JSON.stringify({
              pid: process.pid,
              port: addr.port,
            }),
          );
        }
      });
    },
  };
}

export default defineConfig(async () => {
  const backend = await waitForBackendState();
  const backendPort = backend?.port ?? 3101;
  const port = Number.parseInt(
    process.env.PORT || process.env.HUBRIS_PORT || "3001",
    10,
  );

  return {
    plugins: [react(), tailwindcss(), devInstancePlugin()],
    resolve: {
      alias: {
        "@": path.resolve("./src"),
        ...(isVitest
          ? {
              "@xterm/xterm/css/xterm.css": path.resolve(
                "./src/test/emptyStyle.ts",
              ),
            }
          : {}),
      },
    },
    server: {
      // allowedHosts: ["localhost", "127.0.0.1", "0.0.0.0", "noct"],
      // host: true,
      port,
      hmr: isDesktopDev
        ? {
            protocol: "wss",
            host: desktopDevHost,
            clientPort: 443,
          }
        : undefined,
      proxy: {
        "/api": {
          target: `http://localhost:${backendPort}`,
          ws: true,
        },
        "/_hubris": {
          target: `http://localhost:${backendPort}`,
          ws: true,
        },
        "/code": {
          target: `http://localhost:${backendPort}`,
          ws: true,
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.ts"],
      exclude: [
        "src/lib/components/**",
        ...(isVitestSmoke ? [] : ["src/lib/monaco.runtime.smoke.test.ts"]),
      ],
      coverage: {
        reporter: ["text", "lcov"],
      },
    },
  };
});
