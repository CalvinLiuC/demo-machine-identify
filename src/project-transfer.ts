import * as T from "three";
import type { Project, GeometryItem } from "./types.ts";

export type PackedProject = Omit<Project, "meshes"> & {
  meshes: (Omit<GeometryItem, "geometry"> & {
    positions: Float32Array;
    normals?: Float32Array;
    index?: Uint32Array;
  })[];
};
/** Undo snapshots share immutable geometry buffers, instead of serializing millions of coordinates. */
export function snapshotProject(p: Project): Project {
  const { meshes, ...metadata } = p;
  return {
    ...structuredClone(metadata),
    meshes: meshes.map(({ geometry, ...m }) => ({
      ...structuredClone(m),
      geometry,
    })),
  };
}
export function packProject(p: Project): PackedProject {
  return {
    ...p,
    meshes: p.meshes.map(({ geometry, ...m }) => ({
      ...m,
      positions: new Float32Array(geometry.getAttribute("position").array),
      normals: geometry.getAttribute("normal")
        ? new Float32Array(geometry.getAttribute("normal").array)
        : undefined,
      index: geometry.index ? new Uint32Array(geometry.index.array) : undefined,
    })),
  };
}
export function transferBuffers(p: PackedProject): ArrayBuffer[] {
  return p.meshes.flatMap((m) =>
    [m.positions.buffer, m.normals?.buffer, m.index?.buffer].filter(Boolean),
  ) as ArrayBuffer[];
}
export function unpackProject(p: PackedProject): Project {
  return {
    ...p,
    meshes: p.meshes.map(({ positions, normals, index, ...m }) => {
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
      if (index) geometry.setIndex(new T.BufferAttribute(index, 1));
      if (normals)
        geometry.setAttribute("normal", new T.BufferAttribute(normals, 3));
      else geometry.computeVertexNormals();
      return { ...m, geometry };
    }),
  };
}
