import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { importModel, importSTL, splitConnected } from "../src/import.ts";
import { validate } from "../src/model.ts";
import {
  exportBundle,
  reconstructionError,
  restoreProject,
  projectData,
} from "../src/export.ts";
import { unzipSync } from "fflate";

function solid(name: string, z: number) {
  return `solid ${name}
facet normal 0 0 1
outer loop
vertex 1000 0 ${z}
vertex 2000 0 ${z}
vertex 1000 1000 ${z}
endloop
endfacet
endsolid ${name}\n`;
}

test("ASCII STL preserves solid regions and converts millimeters/Y-up to meters/Z-up", async () => {
  const p = await importSTL(
    new File([solid("a", 0) + solid("b", 1000)], "assembly.stl"),
    0.001,
    "y",
  );
  assert.equal(p.meshes.length, 2);
  assert.equal(p.devices.length, 1);
  assert.equal(p.links.length, 1);
  assert.deepEqual(validate(p), []);
  const pos = p.meshes[0].geometry.getAttribute("position");
  assert.equal(pos.getX(0), 1);
  assert.ok(Math.abs(pos.getZ(2) - 1) < 1e-6);
  assert.ok(
    Math.abs(p.meshes[1].geometry.attributes.position.getY(0) + 1) < 1e-6,
  );
  assert.ok(p.notes.some((n) => n.includes("不提供可靠单位")));
  assert.equal(reconstructionError(p), 0);
});

test("binary STL is detected with an uppercase extension, even with a solid-prefixed header", async () => {
  const mesh = new T.Mesh(new T.BoxGeometry(2, 4, 6));
  mesh.updateMatrixWorld(true);
  const binary = new STLExporter().parse(mesh, { binary: true });
  new Uint8Array(binary.buffer).set(
    new TextEncoder().encode("solid binary header"),
  );
  const p = await importModel(new File([binary], "BOX.STL"), 1, "z");
  p.meshes[0].geometry.computeBoundingBox();
  assert.deepEqual(
    p.meshes[0].geometry.boundingBox.getSize(new T.Vector3()).toArray(),
    [2, 4, 6],
  );
  assert.deepEqual(validate(p), []);
  const restored = restoreProject(JSON.parse(JSON.stringify(projectData(p))));
  assert.equal(restored.meshes[0].geometry.attributes.position.count, 36);
  assert.ok(unzipSync(exportBundle(restored))["devices/imported.urdf"]);
});

test("disconnected geometry within one STL solid can be separated for link grouping", async () => {
  const text =
    solid("one", 0).replace("endsolid one", "") +
    solid("two", 5000)
      .replace("solid two\n", "")
      .replace("endsolid two", "endsolid one");
  const p = await importSTL(new File([text], "parts.stl"), 0.001, "z");
  assert.equal(p.meshes.length, 1);
  assert.equal(splitConnected(p.meshes[0]).length, 2);
});

test("empty, invalid and truncated STL files and invalid import options fail explicitly", async () => {
  for (const data of [
    "",
    "not a mesh",
    "solid empty\nendsolid empty",
    new Uint8Array([0, 1, 2]),
  ])
    await assert.rejects(importSTL(new File([data], "bad.stl")), /STL/);
  await assert.rejects(
    importModel(new File([solid("a", 0)], "a.stl"), 0),
    /尺度/,
  );
  await assert.rejects(
    importModel(new File([solid("a", 0)], "a.stl"), 1, "x"),
    /上方向/,
  );
  await assert.rejects(importModel(new File(["x"], "a.obj")), /GLB 和 STL/);
});
