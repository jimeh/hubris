import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";

const devId = process.env.HUBRIS_DEV_ID;
const devTmp = process.env.HUBRIS_DEV_TMP;

/**
 * Poll for the backend state file and return its
 * contents once the port is available.
 */
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
      // File doesn't exist yet or is incomplete.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Backend did not start within timeout");
}

/**
 * Vite plugin that writes frontend state file after
 * the dev server starts listening.
 */
function devInstancePlugin(): Plugin {
  return {
    name: "hubris-dev-instance",
    configureServer(server) {
      if (!devId || !devTmp) return;

      server.httpServer?.once("listening", () => {
        const addr = server.httpServer!.address();
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

// https://vite.dev/config/
export default defineConfig(async () => {
  const backend = await waitForBackendState();
  const backendPort = backend?.port ?? 3101;

  if (backend) {
    console.log(`Backend ready on port ${backendPort}`);
  }

  const port = parseInt(process.env.HUBRIS_PORT || "3001", 10);

  return {
    plugins: [
      svelte({ inspector: { toggleKeyCombo: "meta-shift" } }),
      tailwindcss(),
      devInstancePlugin(),
    ],
    resolve: {
      alias: {
        $lib: path.resolve("./src/lib"),
      },
    },
    server: {
      port,
      proxy: {
        "/api": {
          target: `http://localhost:${backendPort}`,
          ws: true,
        },
      },
    },
  };
});
