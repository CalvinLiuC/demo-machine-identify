import { splitComponents } from "./topology.ts";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { createProject, identity, bindAt } from "./model.ts";
import type { GeometryItem } from "./types.ts";

export function resolveImportUp(
  file: Pick<File, "name">,
  up = "auto",
): "y" | "z" {
  if (up === "auto")
    return file.name.toLowerCase().endsWith(".stl") ? "z" : "y";
  if (up !== "y" && up !== "z") throw Error("请选择有效的上方向");
  return up;
}
export async function importModel(file: File, scale = 1, up = "auto") {
  up = resolveImportUp(file, up);
  if (!Number.isFinite(scale) || scale <= 0 || !["y", "z"].includes(up))
    throw Error("请选择有效的尺度与上方向");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "glb") return importGLB(file, scale, up);
  if (extension === "stl") return importSTL(file, scale, up);
  throw Error("当前支持 GLB 和 STL 模型");
}

/** STL has no reliable unit, up-axis or mechanical assembly metadata. */
export async function importSTL(file: File, scale = 1, up = "z") {
  if (!Number.isFinite(scale) || scale <= 0 || !["y", "z"].includes(up))
    throw Error("请选择有效的尺度与上方向");
  let geometry: T.BufferGeometry;
  try {
    geometry = new STLLoader().parse(await file.arrayBuffer());
  } catch {
    throw Error("无法解析 STL，请检查文件是否为完整的 ASCII 或二进制 STL");
  }
  try {
    const position = geometry.getAttribute("position");
    if (
      !position ||
      !position.count ||
      position.count % 3 !== 0 ||
      !position.array.every(Number.isFinite)
    )
      throw Error("STL 中没有有效三角网格，或包含无效坐标");
    geometry.applyMatrix4(
      new T.Matrix4()
        .makeRotationX(up === "y" ? Math.PI / 2 : 0)
        .multiply(new T.Matrix4().makeScale(scale, scale, scale)),
    );
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
    // ASCII STL may contain several solid groups. These remain geometry regions,
    // not inferred devices or rigid links. Binary STL usually provides one region.
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: position.count }];
    for (const group of groups) {
      if (!group.count) continue;
      const part = new T.BufferGeometry();
      part.setAttribute(
        "position",
        new T.Float32BufferAttribute(
          position.array.slice(
            group.start * 3,
            (group.start + group.count) * 3,
          ),
          3,
        ),
      );
      part.computeVertexNormals();
      const i = p.meshes.length;
      p.meshes.push({
        id: `mesh_${i}`,
        name: groups.length > 1 ? `${file.name} / ${i + 1}` : file.name,
        link: "import_root",
        geometry: part,
        color: "#a5b6c5",
        source: { format: "stl", file: file.name, region: i },
      });
    }
    p.notes = [
      `输入 ${file.name}（STL）；缩放 ${scale}；源 ${up.toUpperCase()}-up；已规范化到米、Z-up。`,
      "STL 不提供可靠单位、坐标上方向或装配层级；尺度和上方向由导入选项指定。",
      "solid 分组仅作为几何区域；可使用连通分量拆分辅助分组，不代表真实设备或运动连杆。",
      "导入姿态定义为建模参考零位；所有关节及安装关系需要确认。",
    ];
    return p;
  } finally {
    geometry.dispose();
  }
}

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
  return splitComponents(m, tolerance);
}
