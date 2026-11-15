import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("known scene, motion, validation, project roundtrip, ZIP and static GLB import", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#viewport canvas")).toBeVisible();
  await expect(page.locator("#dof-count")).toContainText("8");
  expect(
    await page
      .locator(".center")
      .evaluate((e) => e.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(1000);
  await page.locator('[data-slider="carriage"]').fill("0.5");
  await expect(page.locator("#value-carriage")).toHaveText("500.0 mm");
  await page.locator('[data-slider="finger_left"]').fill("0.025");
  await expect(page.locator("#value-finger_right")).toHaveText("25.0 mm");
  await page.locator("#verify").click();
  await expect(page.locator("#report-content")).toContainText("通过");
  await expect(page.locator("#report-content")).toContainText("0.00e+0 m");
  await page.locator("#close-report").click();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toContainText("停止");
  await page.locator("#reset").click();
  await expect(page.locator("#value-carriage")).toHaveText("0.0 mm");
  const save = page.waitForEvent("download");
  await page.locator("#save").click();
  const project = await save;
  const projectPath = await project.path();
  expect(JSON.parse(await readFile(projectPath, "utf8")).devices).toHaveLength(
    3,
  );
  const zip = page.waitForEvent("download");
  await page.locator("#export").click();
  expect((await zip).suggestedFilename()).toBe("kinematic-assembly.zip");
  await page.locator("#analyze").click();
  await expect(page.locator("#report-content")).toContainText("包围盒");
  const glb = page.waitForEvent("download");
  await page.locator("#download-glb").click();
  const staticPath = await (await glb).path();
  await page.locator("#close-report").click();
  await page.locator("#glb-file").setInputFiles({
    name: "static-scene.glb",
    mimeType: "model/gltf-binary",
    buffer: await readFile(staticPath),
  });
  await expect(page.locator("#scene-title")).toHaveText("static-scene.glb");
  await expect(page.locator("#scene-meta")).toContainText("1 个设备");
  await expect(page.locator("#sliders")).toContainText("还没有运动关节");
  await page.locator("#analyze").click();
  await expect(page.locator("[data-rail]")).toHaveCount(1);
  await page.locator("[data-rail]").click();
  await expect(page.locator("#dof-count")).toContainText("1");
  await expect(page.locator("#tree")).toContainText("导轨候选");
  await page.locator("#undo").click();
  await page.locator("#geometry-tab").click();
  await page.locator("[data-mesh]").first().click();
  await page.locator("#new-device").click();
  await page.locator('#device-form [name="name"]').fill("测试设备");
  await page.locator("#device-form button").click();
  await expect(page.locator("#tree")).toContainText("测试设备");
  await page.locator("#new-link").click();
  await page.locator("#link-form button").click();
  await expect(page.locator("#dof-count")).toContainText("1");
  await page.locator("#project-file").setInputFiles(projectPath);
  await expect(page.locator("#scene-meta")).toContainText("3 个设备");
  await expect(page.locator("#dof-count")).toContainText("8");
  await page.locator('[data-link="axis_4"]').click();
  await page.locator("#fit-axis").click();
  await expect(page.locator("#report-content")).toContainText("圆柱拟合");
  await page.locator("[data-candidate]").first().click();
  await expect(page.locator("#inspector")).toContainText("待确认");
  await page.screenshot({ path: "artifacts/workbench.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("compact screen preserves reachable editor and viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto("/");
  await expect(page.locator("#viewport canvas")).toBeVisible();
  await expect(page.locator("#joint-form")).toBeAttached();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(760);
  await page.screenshot({ path: "artifacts/compact.png", fullPage: true });
});
test("invalid parent cycle is rejected and restores valid project", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[data-link="rail_base"]').click();
  await page.locator('#joint-form [name="parent"]').selectOption("axis_6");
  await page.locator('#joint-form button[type="submit"]').click();
  await expect(page.locator("#toast")).toContainText("循环");
  await page.locator("#verify").click();
  await expect(page.locator("#report-content")).toContainText("通过");
});
