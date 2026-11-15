import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { unzipSync, strFromU8 } from "fflate";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { demo } from "../src/demo.ts";
import { worldMatrices, matrix, validate } from "../src/model.ts";
import {
  assemblyData,
  exportBundle,
  projectData,
  reconstructionError,
  restoreProject,
  urdf,
  origin,
} from "../src/export.ts";
import { axisCandidates } from "../src/geometry.ts";
import { splitConnected } from "../src/import.ts";
import { templateChecks } from "../src/templates.ts";
import { railProposals } from "../src/rail-template.ts";

const near = (a: number, b: number, eps = 1e-7) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const position = (m: T.Matrix4) => new T.Vector3().setFromMatrixPosition(m);
test("known template contains 3 devices, 8 independent DoF and reconstructs reference pose", () => {
  const p = demo();
  assert.deepEqual(validate(p), []);
  assert.equal(p.devices.length, 3);
  assert.equal(
    p.links.filter((l) => l.joint.type !== "fixed" && !l.joint.mimic).length,
    8,
  );
  near(reconstructionError(p), 0);
});
test("rail translation moves robot and gripper, but not fixed rail", () => {
  const p = demo(),
    zero = worldMatrices(p),
    moved = worldMatrices(p, { carriage: 0.7 });
  for (const id of ["carriage", "robot_base", "axis_6", "finger_left"])
    near(position(moved.get(id)).x - position(zero.get(id)).x, 0.7);
  near(position(moved.get("rail_base")).x, 0);
});
test("robot first axis rotates downstream chain about Z while preserving rail", () => {
  const p = demo(),
    m = worldMatrices(p, { axis_1: Math.PI / 2 });
  near(position(m.get("axis_6")).x, 0);
  near(position(m.get("axis_6")).y, 1.28);
  near(position(m.get("carriage")).y, 0);
});
test("symmetric gripper applies mirrored axes with positive mimic multiplier", () => {
  const p = demo(),
    m = worldMatrices(p, { finger_left: 0.025 });
  near(position(m.get("finger_left")).y, 0.09);
  near(position(m.get("finger_right")).y, -0.09);
});
test("local and external transforms compose to original installation", () => {
  const p = demo(),
    a = assemblyData(p);
  assert.equal(a.devices.find((d) => d.id === "robot").parentLink, "carriage");
  assert.equal(a.devices.find((d) => d.id === "gripper").parentLink, "axis_6");
  const root = p.links.find((l) => l.id === "robot_base");
  const composed = matrix(
    p.links.find((l) => l.id === "carriage").bind,
  ).multiply(
    matrix(a.devices.find((d) => d.id === "robot").installationTransform),
  );
  near(position(composed).z, position(matrix(root.bind)).z);
});
test("save/open round trip preserves generated geometries, values and topology", () => {
  const p = demo();
  p.links.find((l) => l.id === "axis_2").joint.value = 0.4;
  const q = restoreProject(JSON.parse(JSON.stringify(projectData(p))));
  assert.deepEqual(validate(q), []);
  assert.equal(q.meshes.length, p.meshes.length);
  assert.equal(
    q.meshes[0].geometry.attributes.position.count,
    p.meshes[0].geometry.attributes.position.count,
  );
  near(q.links.find((l) => l.id === "axis_2").joint.value, 0.4);
  near(reconstructionError(q), 0);
});
test("ZIP includes 3 independent URDFs, combined model, local STL and assembly", () => {
  const p = demo(),
    files = unzipSync(exportBundle(p));
  for (const path of [
    "devices/rail.urdf",
    "devices/robot.urdf",
    "devices/gripper.urdf",
    "scene.urdf",
    "assembly.json",
    "project.json",
    "meshes/robot_base.stl",
  ])
    assert.ok(files[path], path);
  const robot = strFromU8(files["devices/robot.urdf"]);
  assert.ok(!robot.includes('link="carriage"'));
  assert.ok(!robot.includes('link="world"'));
  assert.equal((robot.match(/type="revolute"/g) || []).length, 6);
  const g = new STLLoader().parse(
    new Uint8Array(files["meshes/robot_base.stl"]).buffer,
  );
  g.computeBoundingBox();
  near(g.boundingBox.getCenter(new T.Vector3()).z, 0.11, 1e-6);
  assert.match(urdf(p), /parent link="carriage"/);
  assert.match(urdf(p), /mimic joint="finger_left_joint"/);
});
test("cycles, invalid axes, unsafe IDs and illegal mounting are rejected", () => {
  const p = demo();
  p.links.find((l) => l.id === "rail_base").parent = "axis_6";
  assert.ok(validate(p).some((s) => s.includes("循环")));
  const q = demo();
  q.links.find((l) => l.id === "axis_2").joint.axis = [0, 0, 0];
  assert.ok(validate(q).some((s) => s.includes("轴方向")));
  q.devices[0].id = "../bad";
  assert.ok(validate(q).some((s) => s.includes("标识符")));
  const r = demo();
  r.links.find((l) => l.id === "robot_base").joint.type = "revolute";
  assert.ok(validate(r).some((s) => s.includes("外部安装")));
});
test("cylinder fitter recovers arbitrarily rotated geometric axis", () => {
  const direction = new T.Vector3(1, 2, 3).normalize(),
    g = new T.CylinderGeometry(0.2, 0.2, 1.2, 64);
  g.applyQuaternion(
    new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), direction),
  );
  g.translate(0.7, -0.2, 0.9);
  const fits = axisCandidates({
    id: "x",
    name: "x",
    geometry: g,
    link: "x",
    source: "test",
    color: "#fff",
  }).filter((c) => c.kind === "cylinder");
  assert.ok(fits.length > 0);
  const c = fits[0];
  near(Math.abs(direction.dot(new T.Vector3(...c.direction))), 1, 1e-5);
  near(c.radius, 0.2, 0.005);
  assert.ok(c.residual < 0.005);
});
test("rectangular bar offers principal axis but is not called a cylinder", () => {
  const fits = axisCandidates({
    id: "x",
    name: "x",
    geometry: new T.BoxGeometry(3, 0.2, 0.1),
    link: "x",
    source: "test",
    color: "#fff",
  });
  assert.ok(fits.some((c) => c.kind === "principal"));
  assert.ok(!fits.some((c) => c.kind === "cylinder"));
});
test("connected-component split preserves disconnected surfaces and total triangles", () => {
  const a = new T.BoxGeometry(1, 1, 1).toNonIndexed(),
    b = new T.BoxGeometry(1, 1, 1).toNonIndexed().translate(3, 0, 0);
  const positions = new Float32Array(
    a.attributes.position.array.length + b.attributes.position.array.length,
  );
  positions.set(a.attributes.position.array);
  positions.set(
    b.attributes.position.array,
    a.attributes.position.array.length,
  );
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
  const parts = splitConnected({
    id: "m",
    name: "m",
    link: "l",
    geometry,
    source: "test",
    color: "#fff",
  });
  assert.equal(parts.length, 2);
  assert.equal(
    parts.reduce((n, p) => n + p.geometry.attributes.position.count, 0),
    geometry.attributes.position.count,
  );
});
test("URDF origin RPY recreates an arbitrary rigid reference rotation", () => {
  const original = new T.Matrix4()
      .makeRotationFromEuler(new T.Euler(0.4, -0.8, 1.3, "ZYX"))
      .setPosition(0.2, 0.3, 0.4),
    xml = origin(original);
  const xyz = /xyz="([^"]+)"/.exec(xml)[1].split(" ").map(Number),
    rpy = /rpy="([^"]+)"/.exec(xml)[1].split(" ").map(Number);
  const restored = new T.Matrix4()
    .makeRotationFromEuler(new T.Euler(rpy[0], rpy[1], rpy[2], "ZYX"))
    .setPosition(...(xyz as [number, number, number]));
  original.elements.forEach((v, i) => near(v, restored.elements[i], 1e-8));
});
test("template checks catch missing motion joints without inventing geometry", () => {
  const p = demo();
  assert.ok(templateChecks(p).every((c) => c.status === "拓扑匹配"));
  p.links.find((l) => l.id === "axis_4").joint.type = "fixed";
  assert.ok(
    templateChecks(p)
      .find((c) => c.device === "robot")
      .status.includes("不符"),
  );
});
test("two-profile rail template matches geometry independently of names", () => {
  const p = demo();
  p.meshes.forEach((m) => (m.name = "unreliable"));
  const candidates = railProposals(p);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fixedMeshes.length, 3);
  assert.equal(
    p.meshes.find((m) => m.id === candidates[0].carriageMesh).link,
    "carriage",
  );
  assert.deepEqual(candidates[0].axis, [1, 0, 0]);
});
test("parallel beams without backing and carriage are rejected by rail template", () => {
  const p = demo();
  p.meshes = p.meshes.filter((m) => m.link !== "carriage");
  assert.equal(railProposals(p).length, 0);
});
