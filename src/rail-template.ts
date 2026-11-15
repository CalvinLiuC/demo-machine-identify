import * as T from "three";
import type { Project } from "./types.ts";

export interface RailProposal {
  fixedMeshes: string[];
  carriageMesh: string;
  axis: [number, number, number];
  origin: [number, number, number];
  baseOrigin: [number, number, number];
  evidence: string[];
}

/** A deliberately narrow, geometric two-profile rail matcher. No node names are used. */
export function railProposals(p: Project): RailProposal[] {
  const regions = p.meshes.map((m) => {
    m.geometry.computeBoundingBox();
    const box = m.geometry.boundingBox.clone();
    return {
      id: m.id,
      box,
      size: box.getSize(new T.Vector3()).toArray(),
      center: box.getCenter(new T.Vector3()).toArray(),
    };
  });
  const proposals: RailProposal[] = [];
  for (const dimension of [0, 1]) {
    const transverse = 1 - dimension;
    const profiles = regions.filter(
      (r) =>
        r.size[dimension] > 15 * Math.max(r.size[transverse], r.size[2]) &&
        r.size[2] > 0,
    );
    for (let i = 0; i < profiles.length; i++)
      for (let k = i + 1; k < profiles.length; k++) {
        const a = profiles[i],
          b = profiles[k],
          length = Math.min(a.size[dimension], b.size[dimension]);
        if (Math.abs(a.size[dimension] - b.size[dimension]) > length * 0.05)
          continue;
        if (
          Math.abs(a.center[dimension] - b.center[dimension]) > length * 0.05 ||
          Math.abs(a.center[2] - b.center[2]) > length * 0.01
        )
          continue;
        const spacing = Math.abs(a.center[transverse] - b.center[transverse]);
        if (
          spacing < Math.max(a.size[transverse], b.size[transverse]) * 2 ||
          spacing > length * 0.2
        )
          continue;
        const minZ = Math.min(a.box.min.z, b.box.min.z),
          maxZ = Math.max(a.box.max.z, b.box.max.z),
          middle = (a.center[dimension] + b.center[dimension]) / 2,
          cross = (a.center[transverse] + b.center[transverse]) / 2;
        const supports = regions.filter(
          (r) =>
            r.id !== a.id &&
            r.id !== b.id &&
            Math.abs(r.center[dimension] - middle) < length * 0.05 &&
            Math.abs(r.center[transverse] - cross) < spacing * 0.15 &&
            r.size[dimension] >= length * 0.85 &&
            r.size[dimension] <= length * 1.2 &&
            r.size[transverse] > spacing &&
            r.box.max.z <= minZ + length * 0.01 &&
            minZ - r.box.max.z < length * 0.025,
        );
        // Require the visible backing beam as additional evidence; two neighboring bars alone are not enough.
        if (supports.length !== 1) continue;
        const compact = regions.filter(
          (r) =>
            ![a.id, b.id, supports[0].id].includes(r.id) &&
            Math.abs(r.center[transverse] - cross) < spacing * 0.25 &&
            Math.abs(r.center[dimension] - middle) < length * 0.45 &&
            r.size[dimension] < length * 0.35 &&
            r.size[dimension] > length * 0.04 &&
            r.size[transverse] > spacing * 0.8 &&
            r.size[transverse] < spacing * 2.5 &&
            r.size[2] < length * 0.15 &&
            r.box.min.z >= minZ - length * 0.01 &&
            Math.abs(r.box.min.z - maxZ) < length * 0.035,
        );
        if (compact.length !== 1) continue;
        const carriage = compact[0],
          baseOrigin: [number, number, number] = [0, 0, supports[0].box.min.z];
        baseOrigin[dimension] = middle;
        baseOrigin[transverse] = cross;
        const axis: [number, number, number] = [0, 0, 0];
        axis[dimension] = 1;
        const fixedMeshes = [a.id, b.id, supports[0].id];
        if (proposals.some((c) => c.carriageMesh === carriage.id)) continue;
        proposals.push({
          fixedMeshes,
          carriageMesh: carriage.id,
          axis,
          origin: carriage.center as [number, number, number],
          baseOrigin,
          evidence: [
            "两条等长、平行、横向分离的细长轮廓",
            "下方存在覆盖两条轮廓的长支撑体",
            "上方存在唯一尺寸兼容的紧凑滑台候选",
            "P 关节来自直线导轨模板假设；接触不证明运动，仍须确认。",
          ],
        });
      }
  }
  return proposals;
}
