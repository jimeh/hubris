import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/settings", async (route) => {
    const body = JSON.stringify({
      settings: {
        appearance: {
          colorScheme: "auto",
          lightTheme: "hubris-light",
          darkTheme: "hubris-dark",
        },
        terminal: {
          fontSource: "default",
          systemFontFamily: "",
          bundledFont: "jetbrainsmono-nf",
          fontSize: 14,
        },
        worktree: {
          locationMode: "dataDir",
        },
      },
      generation: "1",
      status: {
        kind: "ok",
        writesBlocked: false,
        message: null,
      },
    });

    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body,
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body,
    });
  });

  await page.route("**/api/events?*", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
      body: [
        "event: snapshot",
        `data: ${JSON.stringify({
          type: "snapshot",
          data: {
            projects: [
              {
                id: "project-1",
                name: "Hubris",
                path: "/tmp/hubris",
                position: 1,
              },
            ],
            worktrees: {
              "project-1": [
                {
                  id: "local-1",
                  project_id: "project-1",
                  name: "local",
                  path: "/tmp/hubris",
                  branch: "main",
                  is_local: true,
                  missing_on_disk: false,
                  position: 1,
                },
              ],
            },
            tabs: [],
            project_errors: {},
            settings: {
              appearance: {
                colorScheme: "auto",
                lightTheme: "hubris-light",
                darkTheme: "hubris-dark",
              },
              terminal: {
                fontSource: "default",
                systemFontFamily: "",
                bundledFont: "jetbrainsmono-nf",
                fontSize: 14,
              },
              worktree: {
                locationMode: "dataDir",
              },
            },
            settings_generation: "1",
            settings_status: {
              kind: "ok",
              writesBlocked: false,
              message: null,
            },
          },
        })}`,
        "",
        "",
      ].join("\n"),
    });
  });
});

test("renders the selected worktree from the SSE snapshot", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("Projects")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hubris" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "local" })).toBeVisible();
  await expect(page.getByText("Click + to open a terminal")).toBeVisible();
});

test("opens the settings dialog from the sidebar", async ({ page }) => {
  await page.goto("/");

  await page.getByTitle("Settings").click();

  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Settings" }).nth(1),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Appearance" })).toBeVisible();
});
