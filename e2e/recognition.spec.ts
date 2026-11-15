import { test, expect } from "@playwright/test";
import * as T from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import type { SceneAnalysis } from "../src/scene-analysis.ts";

test("single STL automatically splits in a worker; candidate review, apply and undo preserve triangles", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#up").selectOption("z");
  const group = new T.Group();
  group.add(
    new T.Mesh(new T.BoxGeometry(1, 1, 1)),
    new T.Mesh(new T.BoxGeometry(0.4, 0.4, 0.4).translate(3, 0, 0)),
  );
  group.updateMatrixWorld(true);
  const binary = new STLExporter().parse(group, { binary: true });
  await page.locator("#model-file").setInputFiles({
    name: "merged.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(binary.buffer as ArrayBuffer),
  });
  await expect(page.locator("#scene-title")).toHaveText("merged.stl");
  await expect(page.locator("#processing")).not.toBeVisible();
  await expect(page.locator("#mesh-count")).toHaveText("2 MESH");
  await expect(page.locator("#recognition-panel")).toContainText(
    "候选 · 尚未应用",
  );
  await page.locator("#analyze").click();
  await expect(page.locator(".recognition-results")).toContainText(
    "自动机构分析",
  );
  await expect(page.locator(".recognition-results")).toContainText("转轴候选");
  await page.locator("#apply-recognition").click();
  await expect(page.locator("#recognition-panel")).toContainText("待确认");
  await expect(page.locator("#dof-count")).toContainText("0");
  await expect(page.locator("#tree")).toContainText("静态结构组候选");
  await page.locator("#verify").click();
  await expect(page.locator("#report-content")).toContainText("通过");
  await page.locator("#close-report").click();
  await page.locator("#undo").click();
  await expect(page.locator("#scene-meta")).toContainText(
    "1 个设备 / 1 个连杆",
  );
  await expect(page.locator("#mesh-count")).toHaveText("2 MESH");
  await page.locator("#auto-reconstruct").click();
  await expect(page.locator(".recognition-results")).toBeVisible();
  expect(errors).toEqual([]);
});

test("full-size private industrial STL: six candidate joints, static structures, source evidence and movement", async ({
  page,
}) => {
  test.skip(
    !process.env.REAL_STL_PATH,
    "set REAL_STL_PATH to run local private model regression",
  );
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#scale").selectOption("0.001");
  await page.locator("#up").selectOption("z");
  await page.locator("#model-file").setInputFiles(process.env.REAL_STL_PATH);
  await expect(page.locator("#scene-title")).toHaveText("model.stl", {
    timeout: 60000,
  });
  await expect(page.locator("#processing")).not.toBeVisible();
  await expect(page.locator("#mesh-count")).toHaveText("126 MESH");
  await expect(page.locator("#recognition-panel")).toContainText(
    "串联机器人候选",
  );
  await page.locator('[data-result-device="articulated_0"]').click();
  await expect(page.locator("#viewport canvas")).toHaveAttribute(
    "data-selected-count",
    /^[1-9]\d*$/,
  );
  const selectedRobotCount = Number(
    await page.locator("#viewport canvas").getAttribute("data-selected-count"),
  );
  await expect(page.locator("#selection-title")).toContainText(
    "串联机器人候选",
  );
  await page.locator("#clear-selection").click();
  await page.locator("#analyze").click();
  await expect(page.locator(".recognition-results")).toContainText(
    "串联机器人候选",
  );
  await expect(page.locator(".recognition-results")).toContainText(
    "两侧同轴几何支持",
  );
  await expect(page.locator(".recognition-results")).toContainText(
    "单侧几何支持",
  );
  const evidenceDownload = page.waitForEvent("download");
  await page.locator("#export-recognition").click();
  const evidence: SceneAnalysis = JSON.parse(
    await readFile(await (await evidenceDownload).path(), "utf8"),
  );
  expect(evidence.componentCount).toBe(126);
  expect(evidence.triangles).toBe(305044);
  expect(
    evidence.devices.find((d) => d.kind === "articulated").links,
  ).toHaveLength(7);
  expect(selectedRobotCount).toBe(
    evidence.devices
      .find((d) => d.kind === "articulated")
      .links.flatMap((l) => l.meshIds).length,
  );
  await page.locator("#apply-recognition").click();
  await expect(page.locator("#dof-count")).toContainText("6");
  await expect(page.locator("#tree")).toContainText("6R");
  await page.locator('[data-slider="articulated_0_link_1"]').fill("0.1");
  await expect(page.locator("#value-articulated_0_link_1")).toContainText(
    "5.7",
  );
  await page.locator("#reset").click();
  await page.locator("#verify").click();
  await expect(page.locator("#report-content")).toContainText("通过");
  await expect(page.locator("#report-content")).toContainText("0.00e+0 m");
  await page.locator("#close-report").click();
  await page.locator('[data-link="articulated_0_link_3"]').click();
  await page.locator("#fit-axis").click();
  await expect(page.locator("#report-content")).toContainText("局部圆形端面");
  await page.locator("#close-report").click();
  const bundle = page.waitForEvent("download");
  await page.locator("#export").click();
  const files = unzipSync(await readFile(await (await bundle).path()));
  expect(files["recognition.json"]).toBeTruthy();
  expect(
    strFromU8(files["devices/articulated_0.urdf"]).match(/type="revolute"/g),
  ).toHaveLength(6);
  await page.screenshot({
    path: "artifacts/recognized-user-model.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
