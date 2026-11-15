import { test, expect } from "@playwright/test";

test("persistent device results select a whole gripper, isolate, focus and clear the visible selection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const panel = page.locator("#recognition-panel"),
    canvas = page.locator("#viewport canvas");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("六轴机器人");
  await expect(panel).toContainText("平行夹爪");
  await expect(panel).toContainText("直线导轨");
  await panel.locator('[data-result-device="gripper"]').click();
  await expect(page.locator("#selection-title")).toHaveText("平行夹爪");
  await expect(page.locator("#selection-detail")).toContainText("3 个几何");
  await expect(canvas).toHaveAttribute("data-selected-count", "3");
  await expect(panel.locator('[data-result-card="gripper"]')).toHaveClass(
    /has-selection/,
  );
  await page.locator("#focus-selection").click();
  await page.locator("#isolate-selection").click();
  await expect(canvas).toHaveAttribute("data-isolated", "true");
  await expect(page.locator("#isolate-selection")).toHaveText("退出隔离");
  await page.screenshot({
    path: "artifacts/selection-gripper.png",
    fullPage: true,
  });
  await page.locator("#clear-selection").click();
  await expect(canvas).toHaveAttribute("data-selected-count", "0");
  await expect(canvas).toHaveAttribute("data-isolated", "false");
  await expect(page.locator("#selection-title")).toHaveText("未选择对象");
  await panel.locator('[data-result-focus="robot"]').click();
  await expect(page.locator("#selection-title")).toHaveText("六轴机器人");
  await canvas.click({ position: { x: 5, y: 5 }, button: "right" });
  await expect(page.locator("#selection-title")).toHaveText("六轴机器人");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-selected-count", "0");
  await page.locator('[data-link="axis_2"]').click();
  await expect(page.locator("#selection-title")).toHaveText("axis_2");
  await page.screenshot({
    path: "artifacts/selection-link.png",
    fullPage: true,
  });
  await canvas.click({ position: { x: 5, y: 5 } });
  await expect(canvas).toHaveAttribute("data-selected-count", "0");
  expect(errors).toEqual([]);
});
