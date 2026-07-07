import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

/**
 * Real end-to-end smoke flow: real server, real SSE, real PTY.
 *
 * Unlike `smoke.spec.ts` (which mocks every API route), nothing here is
 * mocked. The harness in `e2e-smoke.setup.ts` boots the actual
 * `hubris-server` binary with an isolated temp data dir and a throwaway
 * git repo fixture, and this spec drives the full frontend↔backend seam:
 *
 * 1. Load the app served by the real server; the SSE snapshot renders an
 *    empty (real) project list.
 * 2. Register the fixture repo as a project through the Add Project
 *    dialog (REST).
 * 3. The "local" worktree appears via the SSE
 *    `project_worktrees_updated` event.
 * 4. Open a terminal tab and assert real PTY output round-trips through
 *    the terminal WebSocket into xterm.
 * 5. Open the git status ("Changes") panel and assert the fixture repo's
 *    untracked file is listed.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run this spec through the harness config: ` +
        `"mise run test:e2e:real" or ` +
        `"bun run --filter hubris-web test:e2e:real".`,
    );
  }
  return value;
}

// Dump the server log on failure so CI failures are diagnosable from the
// report attachment and job stdout alone.
test.afterEach(async ({ page: _page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) {
    return;
  }

  const logPath = process.env.HUBRIS_E2E_SERVER_LOG;
  if (!logPath || !fs.existsSync(logPath)) {
    return;
  }

  const log = fs.readFileSync(logPath, "utf8");
  await testInfo.attach("hubris-server.log", {
    body: log,
    contentType: "text/plain",
  });
  console.error(
    `\n--- hubris-server log (${logPath}) ---\n${log}--- end server log ---\n`,
  );
});

test("registers a project, runs a real PTY, and shows git status", async ({
  page,
}) => {
  const baseUrl = requiredEnv("HUBRIS_E2E_BASE_URL");
  const fixtureRepo = requiredEnv("HUBRIS_E2E_FIXTURE_REPO");
  const fixtureName = path.basename(fixtureRepo);
  // Project and worktree rows also render in the main-area project
  // preview; scope to the sidebar so role+name lookups stay unambiguous.
  const sidebar = page.locator('[data-sidebar="sidebar"]');

  await page.goto(baseUrl);

  await test.step("SSE snapshot renders the real (empty) project list", async () => {
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add project" }),
    ).toBeVisible();
    // Fresh data dir: the fixture project must not exist yet. This
    // guards against accidentally talking to a non-isolated server.
    await expect(
      sidebar.getByRole("button", { name: fixtureName }),
    ).toHaveCount(0);
  });

  await test.step("register the fixture repo as a project", async () => {
    await page.getByRole("button", { name: "Add project" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Add Project")).toBeVisible();

    const pathInput = dialog.getByPlaceholder("/home/user/repos/myproject");
    // The dialog's file browser resolves a default path asynchronously
    // and overwrites the input; wait for that before filling.
    await expect(pathInput).not.toHaveValue("");
    await pathInput.fill(fixtureRepo);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step("project and local worktree appear via SSE", async () => {
    // exact: true targets the row's name/expand button; the row wrapper
    // itself is also role="button" but its accessible name includes the
    // trailing new-worktree action.
    await expect(
      sidebar.getByRole("button", { name: fixtureName, exact: true }),
    ).toBeVisible();
    // The worktree list arrives via the SSE event stream, not the
    // project-add REST response, so this asserts the live SSE path.
    const worktreeRow = sidebar.getByRole("button", { name: "local" });
    await expect(worktreeRow).toBeVisible({ timeout: 15_000 });
    await worktreeRow.click();
  });

  const terminal = page.locator(".xterm").first();

  await test.step("open a terminal tab and get real PTY output", async () => {
    await page.getByRole("button", { name: "New Terminal" }).click();
    await expect(terminal).toBeVisible({ timeout: 20_000 });

    // Wait for a shell prompt from the real PTY before typing, so
    // keystrokes are not dropped while the WebSocket attaches.
    await expect(terminal).toContainText("$", { timeout: 30_000 });
    await terminal.click();
    // Quoting splits the marker in the echoed command line, so the
    // assertion below can only match actual shell output.
    await page.keyboard.type("echo hubris-e2e-'ok'");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("hubris-e2e-ok", {
      timeout: 30_000,
    });
  });

  await test.step("git status panel shows the fixture repo state", async () => {
    await page.getByRole("button", { name: "Changes" }).click();
    await expect(page.getByText("e2e-note.txt").first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
