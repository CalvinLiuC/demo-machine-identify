import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { createProject, identity, bindAt } from "./model.ts";
import type { GeometryItem } from "./types.ts";
export async function importGLB(file: File, scale = 1, up = "y") {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const draco = new DRACOLoader().setDecoderPath(
    `${import.meta.env.BASE_URL}draco/`,
  );
  loader.setDRACOLoader(draco);
  let gltf;
  try {
    gltf = await loader.parseAsync(await file.arrayBuffer(), "");
  } finally {
    draco.dispose();
  }
  const p = createProject(file.name);
  p.devices.push({ id: "imported", name: "未分类设备", template: "unknown" });
  p.links.push({
    id: "import_root",
    name: "导入根",
    device: "imported",
    parent: null,
    bind: identity(),
    joint: { type: "fixed" },
    confirmed: false,
  });
  gltf.scene.updateMatrixWorld(true);
  const conversion = new T.Matrix4()
    .makeRotationX(up === "y" ? Math.PI / 2 : 0)
    .multiply(new T.Matrix4().makeScale(scale, scale, scale));
  gltf.scene.traverse((o: T.Mesh & { isSkinnedMesh?: boolean }) => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh)
      throw Error("当前 Demo 不支持蒙皮模型，请导出静态刚体网格。");
    const g = o.geometry.clone();
    g.applyMatrix4(conversion.clone().multiply(o.matrixWorld));
    const source = g.index ? g.toNonIndexed() : g;
    const groups = source.groups.length
      ? source.groups
      : [
          {
            start: 0,
            count: source.attributes.position.count,
            materialIndex: 0,
          },
        ];
    for (const group of groups) {
      const part = new T.BufferGeometry();
      for (const name of ["position", "normal"]) {
        const a = source.getAttribute(name);
        if (a)
          part.setAttribute(
            name,
            new T.Float32BufferAttribute(
              a.array.slice(
                group.start * a.itemSize,
                (group.start + group.count) * a.itemSize,
              ),
              a.itemSize,
            ),
          );
      }
      part.computeVertexNormals();
      const material = (
        Array.isArray(o.material) ? o.material[group.materialIndex] : o.material
      ) as T.MeshStandardMaterial;
      const i = p.meshes.length;
      p.meshes.push({
        id: `mesh_${i}`,
        name: o.name || `几何 ${i + 1}`,
        link: "import_root",
        geometry: part,
        color: material?.color
          ? `#${material.color.getHexString()}`
          : "#a5b6c5",
        source: { node: o.name, mesh: o.uuid, primitive: group.materialIndex },
      });
    }
    if (source !== g) source.dispose();
    g.dispose();
  });
  if (!p.meshes.length) throw Error("文件中没有可用三角网格");
  p.notes = [
    `输入 ${file.name}；缩放 ${scale}；源 ${up.toUpperCase()}-up；场景已规范化到米、Z-up。`,
    "节点和材质分组仅作为几何来源，不代表设备或 link。",
    "导入姿态定义为建模参考零位；所有关节及安装关系需要确认。",
  ];
  return p;
}
export function splitConnected(m: GeometryItem, tolerance = 1e-6) {
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry,
    pos = g.getAttribute("position"),
    count = pos.count / 3;
  const parent = Array.from({ length: count }, (_, i) => i),
    find = (i: number) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    },
    vertex = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = [pos.getX(i), pos.getY(i), pos.getZ(i)]
        .map((v) => Math.round(v / tolerance))
        .join(","),
      tri = Math.floor(i / 3);
    if (vertex.has(key)) parent[find(tri)] = find(vertex.get(key));
    else vertex.set(key, tri);
  }
  const groups = new Map();
  for (let t = 0; t < count; t++) {
    const root = find(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  const result = [...groups.values()].map((tris, i) => {
    const coords = [];
    for (const t of tris)
      for (let v = 0; v < 3; v++) {
        const idx = t * 3 + v;
        coords.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
      }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.Float32BufferAttribute(coords, 3));
    geometry.computeVertexNormals();
    return {
      ...m,
      id: `${m.id}_part_${i}`,
      name: `${m.name} / ${i + 1}`,
      geometry,
    };
  });
  if (g !== m.geometry) g.dispose();
  return result;
}
