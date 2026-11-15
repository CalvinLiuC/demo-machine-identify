import * as T from "three";
import { strToU8, zipSync } from "fflate";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { matrix, validate, worldMatrices } from "./model.ts";
import type { Project } from "./types.ts";

const escape = (s: unknown) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const nums = (v: number[]) =>
  v.map((n) => (Math.abs(n) < 1e-12 ? 0 : Number(n.toFixed(9)))).join(" ");
export function origin(m: T.Matrix4) {
  const position = new T.Vector3(),
    q = new T.Quaternion(),
    s = new T.Vector3();
  m.decompose(position, q, s);
  const e = new T.Euler().setFromQuaternion(q, "ZYX");
  return `<origin xyz="${nums(position.toArray())}" rpy="${nums([e.x, e.y, e.z])}"/>`;
}
export function urdf(p: Project, device: string = null) {
  const links = device ? p.links.filter((l) => l.device === device) : p.links;
  const includes = new Set(links.map((l) => l.id));
  const chunks = [
    '<?xml version="1.0"?>',
    `<robot name="${escape(device || "assembled_scene")}">`,
    "<!-- Kinematic review model. Limits, velocity and effort are DEMO placeholders, not manufacturer specifications. -->",
  ];
  if (!device) chunks.push('<link name="world"/>');
  for (const l of links) {
    chunks.push(`  <link name="${escape(l.id)}">`);
    if (p.meshes.some((m) => m.link === l.id))
      chunks.push(
        `    <visual><geometry><mesh filename="package://kinematic_scene_demo/meshes/${escape(l.id)}.stl"/></geometry><material name="${escape(l.id)}_material"><color rgba="0.65 0.72 0.8 1"/></material></visual>`,
      );
    chunks.push("  </link>");
    const parent = includes.has(l.parent)
      ? p.links.find((x) => x.id === l.parent)
      : null;
    if (device && !parent) continue;
    const j = l.joint || { type: "fixed" },
      relative = parent
        ? matrix(parent.bind).invert().multiply(matrix(l.bind))
        : matrix(l.bind);
    chunks.push(
      `  <joint name="${escape(l.id)}_joint" type="${parent ? j.type : "fixed"}"><parent link="${escape(parent?.id || "world")}"/><child link="${escape(l.id)}"/>${origin(relative)}`,
    );
    if (parent && j.type !== "fixed") {
      chunks.push(
        `<axis xyz="${nums(new T.Vector3(...j.axis).normalize().toArray())}"/><limit lower="${j.lower}" upper="${j.upper}" effort="1" velocity="1"/>`,
      );
      if (j.mimic)
        chunks.push(
          `<mimic joint="${escape(j.mimic)}_joint" multiplier="${j.multiplier ?? 1}" offset="${j.offset ?? 0}"/>`,
        );
    }
    chunks.push("  </joint>");
  }
  chunks.push("</robot>");
  return chunks.join("\n");
}
export function projectData(p: Project) {
  return {
    ...p,
    meshes: p.meshes.map(({ geometry, ...m }) => ({
      ...m,
      geometry: new T.BufferGeometry().copy(geometry).toJSON(),
    })),
  };
}
export function restoreProject(data: ReturnType<typeof projectData>): Project {
  if (
    data.version !== 1 ||
    !Array.isArray(data.links) ||
    !Array.isArray(data.devices) ||
    !Array.isArray(data.meshes)
  )
    throw Error("不支持的项目文件");
  const loader = new T.BufferGeometryLoader();
  const p = {
    ...data,
    meshes: data.meshes.map((m) => ({
      ...m,
      geometry: loader.parse(m.geometry),
    })),
  };
  const errors = validate(p);
  if (errors.length) throw Error(errors.join("；"));
  return p;
}
export function assemblyData(p: Project) {
  return {
    version: 1,
    unit: "m",
    reference: p.reference,
    notes: p.notes,
    devices: p.devices.map((d) => {
      const root = p.links.find(
        (l) =>
          l.device === d.id &&
          (!l.parent ||
            p.links.find((x) => x.id === l.parent)?.device !== d.id),
      );
      const parent = p.links.find((l) => l.id === root?.parent);
      return {
        ...d,
        urdf: `devices/${d.id}.urdf`,
        rootLink: root?.id,
        parentDevice: parent?.device || null,
        parentLink: parent?.id || "world",
        childInterface: root?.id,
        parentInterface: parent?.id || "world",
        installationTransform: root
          ? (parent
              ? matrix(parent.bind).invert().multiply(matrix(root.bind))
              : matrix(root.bind)
            ).toArray()
          : null,
        confirmed: root?.confirmed ?? false,
      };
    }),
    initialState: Object.fromEntries(
      p.links
        .filter((l) => l.joint?.type !== "fixed")
        .map((l) => [`${l.id}_joint`, 0]),
    ),
    previewState: Object.fromEntries(
      p.links
        .filter((l) => l.joint?.type !== "fixed")
        .map((l) => [`${l.id}_joint`, l.joint?.value ?? 0]),
    ),
    parameters: p.links.map((l) => ({
      link: l.id,
      joint: l.joint,
      confirmed: l.confirmed,
      referenceTransform: l.bind,
    })),
    warnings: [
      "initialState=0 reconstructs the imported reference pose; previewState stores current independent sliders. Mimic values must be resolved.",
      "All limits are demo ranges; effort and velocity in URDF are compatibility placeholders. No manufacturer limits or zero are inferred.",
    ],
  };
}
export function exportBundle(p: Project) {
  const errors = validate(p);
  if (errors.length) throw Error(errors.join("；"));
  const files: Record<string, Uint8Array> = {},
    put = (name: string, s: string) => (files[name] = strToU8(s));
  const exporter = new STLExporter();
  for (const l of p.links) {
    const group = new T.Group();
    for (const m of p.meshes.filter((x) => x.link === l.id)) {
      const g = m.geometry.clone().applyMatrix4(matrix(l.bind).invert());
      group.add(new T.Mesh(g));
    }
    if (group.children.length) {
      group.updateMatrixWorld(true);
      put(`meshes/${l.id}.stl`, exporter.parse(group));
    }
    group.children.forEach((m: T.Mesh) => m.geometry.dispose());
  }
  p.devices.forEach((d) => put(`devices/${d.id}.urdf`, urdf(p, d.id)));
  put(
    "package.xml",
    '<?xml version="1.0"?><package format="3"><name>kinematic_scene_demo</name><version>0.1.0</version><description>Kinematic review scene exported by Kinematic Lab</description><maintainer email="demo@example.com">Demo</maintainer><license>UNLICENSED</license><buildtool_depend>ament_cmake</buildtool_depend><export><build_type>ament_cmake</build_type></export></package>',
  );
  put(
    "CMakeLists.txt",
    "cmake_minimum_required(VERSION 3.8)\nproject(kinematic_scene_demo)\nfind_package(ament_cmake REQUIRED)\ninstall(DIRECTORY devices meshes DESTINATION share/${PROJECT_NAME})\ninstall(FILES scene.urdf assembly.json DESTINATION share/${PROJECT_NAME})\nament_package()\n",
  );
  put("scene.urdf", urdf(p));
  put("assembly.json", JSON.stringify(assemblyData(p), null, 2));
  put("project.json", JSON.stringify(projectData(p)));
  put(
    "README.txt",
    "Kinematic Scene Lab\nUnits: meters, right-handed Z-up.\nThis folder is a ROS 2 ament_cmake resource package named kinematic_scene_demo. Place it in a workspace src folder, run colcon build, then source install/setup.bash (Windows: install/setup.ps1). Mesh paths use package://kinematic_scene_demo/meshes/*.stl. Standalone consumers must configure a package resolver for this folder. ROS runtime integration was not tested by this browser demo.\nOpen scene.urdf, or load individual devices/*.urdf at identity and apply assembly.json installation transforms.\ninitialState=0 is the imported model reference, NOT manufacturer zero. previewState contains the UI values; mimic joints follow their source.\nAll motion ranges are DEMO ranges. URDF effort/velocity are placeholders. No dynamics, collision or physical limits are provided.\nMeshes are exported to link-local STL (material and texture are not preserved in URDF). project.json preserves geometry and basic colors for reopening this demo.\n",
  );
  return zipSync(files);
}
export function reconstructionError(p: Project) {
  const worlds = worldMatrices(
    p,
    Object.fromEntries(p.links.map((l) => [l.id, 0])),
  );
  let max = 0;
  for (const m of p.meshes) {
    const l = p.links.find((l) => l.id === m.link);
    if (!l) continue;
    const delta = worlds.get(l.id).clone().multiply(matrix(l.bind).invert());
    const pos = m.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const a = new T.Vector3().fromBufferAttribute(pos, i);
      max = Math.max(max, a.distanceTo(a.clone().applyMatrix4(delta)));
    }
  }
  return max;
}
