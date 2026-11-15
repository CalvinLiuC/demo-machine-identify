import { test, expect } from "@playwright/test";
import * as T from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { readFile } from "node:fs/promises";
import type { SceneAnalysis } from "../src/scene-analysis.ts";
const cylinder = (
  r: number,
  h: number,
  p: [number, number, number],
  z = false,
) => {
  const g = new T.CylinderGeometry(r, r, h, 64);
  if (z) g.rotateX(Math.PI / 2);
  return new T.Mesh(g.translate(...p));
};
test("single and dual axis positioners appear in results and a fresh analysis is never shown as already applied", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#up").selectOption("z");
  const fixtures = [
    {
      name: "single.stl",
      label: "单轴变位机",
      dof: 1,
      meshes: [
        new T.Mesh(new T.BoxGeometry(0.6, 0.6, 0.25).translate(0, 0, 0.125)),
        cylinder(0.3, 0.05, [0, 0, 0.28], true),
      ],
    },
    {
      name: "dual.stl",
      label: "双轴变位机",
      dof: 2,
      meshes: [
        cylinder(0.35, 0.12, [0, -0.14, 0.4]),
        cylinder(0.25, 0.14, [0, 0, 0.4]),
        cylinder(0.3, 0.05, [0, 0, 0.68], true),
      ],
    },
  ];
  for (const f of fixtures) {
    const group = new T.Group();
    group.add(...f.meshes);
    group.updateMatrixWorld(true);
    const binary = new STLExporter().parse(group, { binary: true });
    await page.locator("#model-file").setInputFiles({
      name: f.name,
      mimeType: "model/stl",
      buffer: Buffer.from(binary.buffer as ArrayBuffer),
    });
    await expect(page.locator("#scene-title")).toHaveText(f.name);
    await expect(page.locator("#recognition-panel")).toContainText(f.label);
    await page.locator("#results-apply").click();
    await expect(page.locator("#dof-count")).toContainText(String(f.dof));
    await page.locator("#auto-reconstruct").click();
    await expect(page.locator("#recognition-panel")).toContainText("尚未应用");
    await page.locator("#close-report").click();
    await page.locator("#results-apply").click();
    await expect(page.locator("#recognition-panel")).toContainText("待确认");
  }
});
test("model2 displays a six-axis robot, separately mounted gripper and positioner", async ({
  page,
}) => {
  test.skip(!process.env.REAL_STL_2_PATH, "local private model2 regression");
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#scale").selectOption("0.001");
  await expect(page.locator("#up")).toHaveValue("auto");
  await page.locator("#model-file").setInputFiles(process.env.REAL_STL_2_PATH);
  await expect(page.locator("#scene-title")).toHaveText("model2.stl", {
    timeout: 90000,
  });
  await expect(page.locator("#recognition-panel")).toContainText(
    "末端夹爪候选",
  );
  await expect(page.locator("#recognition-panel")).toContainText(
    "单轴变位机候选",
  );
  await expect(
    page.locator('[data-result-card="articulated_0"]'),
  ).toContainText("6 R / 0 P");
  await page.locator("#analyze").click();
  const event = page.waitForEvent("download");
  await page.locator("#export-recognition").click();
  const a: SceneAnalysis = JSON.parse(
    await readFile(await (await event).path(), "utf8"),
  );
  const robot = a.devices.find((d) => d.kind === "articulated"),
    grip = a.devices.find((d) => d.kind === "gripper");
  expect(a.algorithmVersion).toBe("geometry-0.4");
  expect(a.componentCount).toBe(1208);
  expect(robot.links).toHaveLength(7);
  expect(robot.links.filter((l) => l.joint?.axis)).toHaveLength(6);
  expect(robot.links.at(-1).joint.alternatives[0].method).toBe("bolt-pattern");
  expect(grip.parentProposal).toBe(robot.id);
  await page.locator("#apply-recognition").click();
  await page.locator('[data-slider="articulated_0_link_6"]').fill("0.1");
  await expect(page.locator("#value-articulated_0_link_6")).toContainText(
    "5.7",
  );
  await page.locator("#reset").click();
  await page.locator("#verify").click();
  await expect(page.locator("#report-content")).toContainText("通过");
  await page.locator("#close-report").click();
  await page.locator('[data-result-focus="gripper_0"]').click();
  await expect(page.locator("#selection-title")).toContainText("夹爪");
  await page.screenshot({
    path: "artifacts/model2-recognized.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
