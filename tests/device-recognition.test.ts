import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { readFile } from "node:fs/promises";
import {
  createProject,
  identity,
  validate,
  worldMatrices,
} from "../src/model.ts";
import {
  recognizeScene,
  decomposeScene,
  applySceneAnalysis,
  coaxialJoints,
  type ProposedJoint,
} from "../src/scene-analysis.ts";
import { importSTL } from "../src/import.ts";
import { templateChecks } from "../src/templates.ts";
import { resultDevices } from "../src/results-panel.ts";
import { reconstructionError, exportBundle } from "../src/export.ts";
import { unzipSync, strFromU8 } from "fflate";
import { describeSurface } from "../src/surface-features.ts";

test("oblique circular end faces survive six-significant-digit STL coordinate rounding", () => {
  const axis = new T.Vector3(0.98676, -0.028438, -0.159674).normalize(),
    g = new T.CylinderGeometry(0.055, 0.055, 0.15, 64)
      .applyQuaternion(
        new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), axis),
      )
      .translate(1.317, -0.074, 1.239),
    position = g.attributes.position;
  for (let i = 0; i < position.array.length; i++)
    position.array[i] = Number(position.array[i].toPrecision(6));
  const d = describeSurface({
    id: "rounded",
    name: "rounded",
    link: "root",
    geometry: g,
    color: "#aaa",
    source: "test",
  });
  assert.ok(
    d.circles.some(
      (c) =>
        Math.abs(new T.Vector3(...c.axis).dot(axis)) > 0.999 &&
        Math.abs(c.radius - 0.055) < 0.002,
    ),
  );
});

function fixture(geometries: T.BufferGeometry[]) {
  const p = createProject("fixture");
  p.devices = [{ id: "input", name: "unknown", template: "unknown" }];
  p.links = [
    {
      id: "root",
      name: "root",
      device: "input",
      parent: null,
      bind: identity(),
      joint: { type: "fixed" },
      confirmed: false,
    },
  ];
  p.meshes = geometries.map((geometry, i) => ({
    id: `part_${i}`,
    name: "unnamed",
    link: "root",
    geometry,
    color: "#aaa",
    source: "synthetic",
  }));
  return p;
}
const disk = (
  r: number,
  h: number,
  point: [number, number, number],
  up = "z",
) => {
  const g = new T.CylinderGeometry(r, r, h, 64);
  if (up === "z") g.rotateX(Math.PI / 2);
  g.translate(...point);
  return g;
};
test("single-axis positioner requires a circular workplate and substantial support", () => {
  const p = fixture([
    new T.BoxGeometry(0.6, 0.6, 0.25).translate(0, 0, 0.125),
    disk(0.3, 0.05, [0, 0, 0.28]),
  ]);
  const a = recognizeScene(p);
  const candidate = a.devices.find((d) => d.kind === "positioner");
  assert.ok(candidate);
  assert.equal(candidate.template, "positioner_1R");
  assert.equal(candidate.links.length, 2);
  applySceneAnalysis(p, a);
  assert.deepEqual(validate(p), []);
  assert.equal(
    templateChecks(p).find((d) => d.device === candidate.id).status,
    "拓扑匹配",
  );
  assert.equal(reconstructionError(p), 0);
});
test("two-axis positioner identifies perpendicular tilt and table axes without calling it a robot", () => {
  const p = fixture([
    disk(0.35, 0.12, [0, -0.14, 0.4], "y"),
    disk(0.25, 0.14, [0, 0, 0.4], "y"),
    disk(0.3, 0.05, [0, 0, 0.68]),
  ]);
  const a = recognizeScene(p);
  assert.equal(a.devices.filter((d) => d.kind === "articulated").length, 0);
  const d = a.devices.find(
    (d) => d.kind === "positioner" && d.template === "positioner_2R",
  );
  assert.ok(d);
  assert.equal(d.links.length, 3);
  assert.ok(
    Math.abs(
      new T.Vector3(...d.links[1].joint.axis).dot(
        new T.Vector3(...d.links[2].joint.axis),
      ),
    ) < 0.25,
  );
  applySceneAnalysis(p, a);
  assert.deepEqual(validate(p), []);
  assert.equal(
    templateChecks(p).find((x) => x.device === d.id).status,
    "拓扑匹配",
  );
  const base = p.links.find((l) => l.device === d.id && !l.parent),
    turn = p.links.find((l) => l.parent === base.id),
    before = worldMatrices(p),
    after = worldMatrices(p, { [turn.id]: 0.1 });
  assert.deepEqual(before.get(base.id).elements, after.get(base.id).elements);
});
test("rectangular plates, floating disks and small fasteners are not sufficient positioner evidence", () => {
  for (const geometries of [
    [
      new T.BoxGeometry(0.6, 0.6, 0.25),
      new T.BoxGeometry(0.6, 0.6, 0.05).translate(0, 0, 0.2),
    ],
    [disk(0.3, 0.05, [0, 0, 0])],
  ])
    assert.equal(
      recognizeScene(fixture(geometries)).devices.filter(
        (d) => d.kind === "positioner",
      ).length,
      0,
    );
});
test("re-analysis remains pending even when new candidate IDs equal old applied IDs", () => {
  const p = fixture([new T.BoxGeometry(1, 1, 1)]),
    a = recognizeScene(p);
  applySceneAnalysis(p, a);
  assert.ok(resultDevices(p).every((d) => !d.pending));
  const next = recognizeScene(p);
  assert.deepEqual(
    next.devices.map((d) => d.id),
    a.devices.map((d) => d.id),
  );
  p.analysis = next;
  assert.ok(resultDevices(p).every((d) => d.pending));
});
test("parallel robot shoulder and elbow axes are not collapsed unless they are on the same line", () => {
  const a: ProposedJoint = {
    origin: [0, 0, 0] as [number, number, number],
    axis: [0, 1, 0] as [number, number, number],
    status: "candidate" as const,
    support: "one-sided" as const,
    alternatives: [],
    evidence: [],
  };
  assert.equal(coaxialJoints(a, { ...a, origin: [0, 0.05, 0] }, 2), true);
  assert.equal(coaxialJoints(a, { ...a, origin: [0, 0, 0.5] }, 2), false);
});
test(
  "model2 private regression: six robot axes, separate gripper, positioner and nonduplicated motion",
  { skip: !process.env.REAL_STL_2_PATH },
  async () => {
    const p = await importSTL(
      new File([await readFile(process.env.REAL_STL_2_PATH)], "model2.stl"),
      0.001,
      "z",
    );
    const source = decomposeScene(p),
      a = recognizeScene(p, source),
      robot = a.devices.find((d) => d.kind === "articulated"),
      gripper = a.devices.find((d) => d.kind === "gripper");
    assert.equal(a.componentCount, 1208);
    assert.ok(robot);
    assert.equal(robot.links.filter((l) => l.joint?.axis).length, 6);
    assert.equal(robot.links.length, 7);
    assert.equal(robot.links.at(-1).virtual, true);
    assert.equal(
      robot.links.at(-1).joint.alternatives[0].method,
      "bolt-pattern",
    );
    assert.ok(gripper);
    assert.equal(gripper.parentProposal, robot.id);
    assert.equal(gripper.parentLinkIndex, 6);
    assert.ok(a.devices.some((d) => d.kind === "positioner"));
    assert.ok(
      gripper.links.slice(1).every((l) => l.joint.status === "unresolved"),
    );
    for (let i = 2; i < robot.links.length; i++)
      assert.equal(
        coaxialJoints(robot.links[i - 1].joint, robot.links[i].joint, 3),
        false,
      );
    const robotMeshes = new Set(robot.links.flatMap((l) => l.meshIds));
    assert.ok(
      gripper.links
        .flatMap((l) => l.meshIds)
        .every((id) => !robotMeshes.has(id)),
    );
    applySceneAnalysis(p, a);
    assert.deepEqual(validate(p), []);
    assert.equal(reconstructionError(p), 0);
    const root = p.links.find(
      (l) => l.device === gripper.id && l.parent?.startsWith(robot.id),
    );
    assert.equal(root.parent, `${robot.id}_link_6`);
    const base = p.links.find((l) => l.id === `${robot.id}_link_0`);
    const first = p.links.find((l) => l.id === `${robot.id}_link_1`);
    assert.ok(p.meshes.some((m) => m.link === base.id));
    assert.ok(p.meshes.some((m) => m.link === first.id));
    assert.equal(first.parent, base.id);
    assert.equal(base.joint.type, "fixed");
    assert.ok(
      robot.links[0].meshIds.every(
        (id) => !robot.links[1].meshIds.includes(id),
      ),
    );
    const before = worldMatrices(p),
      firstMotion = worldMatrices(p, { [first.id]: 0.2 }),
      moving = worldMatrices(p, { [`${robot.id}_link_6`]: 0.1 });
    assert.deepEqual(
      before.get(base.id).elements,
      firstMotion.get(base.id).elements,
    );
    assert.notDeepEqual(
      before.get(first.id).elements,
      firstMotion.get(first.id).elements,
    );
    assert.notDeepEqual(
      before.get(root.id).elements,
      moving.get(root.id).elements,
    );
    for (const l of p.links.filter(
      (l) => l.device !== robot.id && l.device !== gripper.id,
    ))
      assert.deepEqual(before.get(l.id).elements, moving.get(l.id).elements);
    const files = unzipSync(exportBundle(p));
    assert.equal(
      (
        strFromU8(files[`devices/${robot.id}.urdf`]).match(
          /type="revolute"/g,
        ) || []
      ).length,
      6,
    );
    const urdf = strFromU8(files[`devices/${robot.id}.urdf`]);
    assert.equal((urdf.match(/<link name=/g) || []).length, 7);
    assert.ok(
      urdf.includes(`<parent link="${base.id}"/><child link="${first.id}"/>`),
    );
    assert.ok(files[`devices/${gripper.id}.urdf`]);
  },
);
