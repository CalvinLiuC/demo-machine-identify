import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as T from "three";
import {
  decomposeScene,
  recognizeScene,
  applySceneAnalysis,
  type SceneAnalysis,
} from "../src/scene-analysis.ts";
import { describeSurface } from "../src/surface-features.ts";
import { splitComponents } from "../src/topology.ts";
import {
  packProject,
  unpackProject,
  snapshotProject,
} from "../src/project-transfer.ts";
import {
  createProject,
  identity,
  validate,
  worldMatrices,
} from "../src/model.ts";
import {
  reconstructionError,
  exportBundle,
  projectData,
  restoreProject,
} from "../src/export.ts";
import { importSTL } from "../src/import.ts";
import { demo } from "../src/demo.ts";
import { unzipSync } from "fflate";

function merged(geometries: T.BufferGeometry[]) {
  const arrays = geometries.map(
    (g) => (g.index ? g.toNonIndexed() : g).getAttribute("position").array,
  );
  const positions = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
  let start = 0;
  for (const a of arrays) {
    positions.set(a, start);
    start += a.length;
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}
function scene(geometry: T.BufferGeometry) {
  const p = createProject("merged_scene");
  p.devices = [{ id: "input", name: "未知", template: "unknown" }];
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
  p.meshes = [
    {
      id: "input_mesh",
      name: "无语义网格",
      link: "root",
      geometry,
      color: "#aaa",
      source: "test",
    },
  ];
  return p;
}
test("automatic decomposition preserves all triangles and exact source-face coverage", () => {
  const p = scene(
    merged([
      new T.BoxGeometry(1, 1, 1),
      new T.BoxGeometry(1, 1, 1).translate(3, 0, 0),
    ]),
  );
  assert.equal(decomposeScene(p), 1);
  assert.equal(p.meshes.length, 2);
  const ranges = p.meshes.flatMap(
    (m) => (m.source as { triangleRanges: number[][] }).triangleRanges,
  );
  const ids = ranges
    .flatMap(([start, count]) =>
      Array.from({ length: count }, (_, i) => start + i),
    )
    .sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    Array.from({ length: 24 }, (_, i) => i),
  );
  assert.equal(
    p.meshes.reduce((s, m) => s + m.geometry.attributes.position.count / 3, 0),
    24,
  );
});
test("local circular end faces are found inside a complex compound mesh at arbitrary orientation", () => {
  const direction = new T.Vector3(1, 2, 3).normalize(),
    q = new T.Quaternion().setFromUnitVectors(
      new T.Vector3(0, 1, 0),
      direction,
    );
  const cylinder = new T.CylinderGeometry(0.12, 0.12, 0.4, 64).applyQuaternion(
      q,
    ),
    box = new T.BoxGeometry(0.7, 0.4, 0.2).translate(0.8, 0.4, 0.5);
  const d = describeSurface({
    id: "body",
    name: "body",
    link: "root",
    geometry: merged([cylinder, box]),
    color: "#aaa",
    source: "test",
  });
  assert.ok(
    d.circles.some(
      (c) =>
        Math.abs(new T.Vector3(...c.axis).dot(direction)) > 0.999 &&
        Math.abs(c.radius - 0.12) < 0.003,
    ),
  );
  assert.ok(d.circles.every((c) => c.error < c.radius * 0.025));
});
test("box structures and a single welded body do not become a fabricated six-axis robot", () => {
  for (const g of [
    new T.BoxGeometry(1, 1, 1),
    merged([
      new T.BoxGeometry(1, 1, 1),
      new T.BoxGeometry(0.3, 0.2, 0.1).translate(3, 0, 0),
    ]),
  ]) {
    const p = scene(g);
    decomposeScene(p);
    const a = recognizeScene(p, 1);
    assert.equal(a.devices.filter((d) => d.kind === "articulated").length, 0);
    assert.equal(
      a.devices.flatMap((d) => d.links).filter((l) => l.joint?.axis).length,
      0,
    );
    applySceneAnalysis(p, a);
    assert.deepEqual(validate(p), []);
    assert.equal(reconstructionError(p), 0);
    if (a.componentCount === 1)
      assert.ok(a.warnings.some((w) => w.includes("焊接")));
  }
});
test("same-axis cylinders alone are insufficient evidence for an articulated robot", () => {
  const p = scene(
    merged(
      [0, 0.42, 0.84].map((x) =>
        new T.CylinderGeometry(0.1, 0.1, 0.4, 32).translate(x, 0, 0),
      ),
    ),
  );
  decomposeScene(p);
  assert.equal(
    recognizeScene(p).devices.filter((d) => d.kind === "articulated").length,
    0,
  );
});
test("worker transfer and undo preserve geometry, while metadata stays independent", () => {
  const p = demo(),
    snapshot = snapshotProject(p),
    packed = packProject(p),
    roundtrip = unpackProject(packed);
  assert.equal(snapshot.meshes[0].geometry, p.meshes[0].geometry);
  p.links[0].name = "changed";
  assert.notEqual(snapshot.links[0].name, p.links[0].name);
  p.links[1].joint.axis[0] = 9;
  assert.notEqual(snapshot.links[1].joint.axis[0], 9);
  assert.deepEqual(validate(roundtrip), []);
  assert.equal(reconstructionError(roundtrip), 0);
  assert.deepEqual(
    Array.from(roundtrip.meshes[0].geometry.attributes.position.array),
    Array.from(p.meshes[0].geometry.attributes.position.array),
  );
});
test("applying invalid recognition cannot partially destroy the current project", () => {
  const p = scene(new T.BoxGeometry(1, 1, 1));
  const a = recognizeScene(p);
  a.devices[0].links[0].anchor = "missing";
  const before = snapshotProject(p);
  assert.throws(() => applySceneAnalysis(p, a), /主体/);
  assert.deepEqual(p, before);
  const b = recognizeScene(p);
  b.devices[0].links[0].meshIds.push("missing");
  assert.throws(() => applySceneAnalysis(p, b), /覆盖/);
  assert.deepEqual(p, before);
});
test(
  "private full-size single-STL regression: decomposition, six candidate axes, uncertainty and export",
  { skip: !process.env.REAL_STL_PATH },
  async () => {
    const p = await importSTL(
      new File([await readFile(process.env.REAL_STL_PATH)], "scene.stl"),
      0.001,
      "z",
    );
    const source = decomposeScene(p),
      a = recognizeScene(p, source),
      robot = a.devices.find((d) => d.kind === "articulated");
    assert.equal(a.componentCount, 126);
    assert.equal(a.triangles, 305044);
    assert.ok(robot);
    assert.equal(robot.links.length, 7);
    assert.equal(robot.links.filter((l) => l.joint?.axis).length, 6);
    assert.ok(
      robot.links.filter((l) => l.joint?.support === "two-sided").length >= 3,
    );
    assert.ok(
      robot.links.filter((l) => l.joint?.support === "one-sided").length >= 1,
    );
    assert.ok(a.devices.some((d) => d.kind === "unknown"));
    assert.ok(a.ambiguousMeshes.length > 0);
    applySceneAnalysis(p, a);
    assert.deepEqual(validate(p), []);
    assert.ok(p.links.every((l) => !l.confirmed));
    assert.equal(reconstructionError(p), 0);
    const root = p.links.find((l) => l.device === robot.id),
      first = p.links.find((l) => l.parent === root.id),
      states = { [first.id]: 0.1 };
    const zero = worldMatrices(p),
      moved = worldMatrices(p, states);
    for (const l of p.links.filter((l) => l.device !== robot.id))
      assert.deepEqual(moved.get(l.id).elements, zero.get(l.id).elements);
    assert.notDeepEqual(
      moved.get(first.id).elements,
      zero.get(first.id).elements,
    );
    const restored = restoreProject(JSON.parse(JSON.stringify(projectData(p))));
    assert.equal(restored.analysis.componentCount, 126);
    assert.ok(unzipSync(exportBundle(p))["recognition.json"]);
  },
);
