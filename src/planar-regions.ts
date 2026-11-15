import * as T from "three";

export interface PlanarPatch {
  normal: T.Vector3;
  area: number;
  faces: number[];
}
/** Join coplanar neighboring facets before circle fitting. Quantized normal/offset
 * bins alone fragment oblique CAD end faces after STL coordinate rounding. */
export function adjacentPlanarPatches(
  p: T.BufferAttribute | T.InterleavedBufferAttribute,
  diagonal: number,
): PlanarPatch[] {
  const count = p.count / 3;
  if (count < 20) return [];
  const parent = new Int32Array(count),
    normals: T.Vector3[] = [],
    centers: T.Vector3[] = [],
    areas = new Float64Array(count),
    edges = new Map<string, number>();
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const at = (i: number) => new T.Vector3().fromBufferAttribute(p, i),
    key = (v: T.Vector3) =>
      v
        .toArray()
        .map((x) => Math.round(x / 1e-6))
        .join(",");
  const tolerance = Math.max(diagonal * 3e-4, 2e-6);
  for (let i = 0; i < count; i++) {
    parent[i] = i;
    const a = at(i * 3),
      b = at(i * 3 + 1),
      c = at(i * 3 + 2),
      normal = b.clone().sub(a).cross(c.clone().sub(a));
    areas[i] = normal.length() / 2;
    normal.normalize();
    normals.push(normal);
    centers.push(a.clone().add(b).add(c).divideScalar(3));
    const vertices = [a, b, c],
      keys = vertices.map(key);
    for (let j = 0; j < 3; j++) {
      const edge = [keys[j], keys[(j + 1) % 3]].sort().join("|"),
        other = edges.get(edge);
      if (other === undefined) {
        edges.set(edge, i);
        continue;
      }
      if (
        areas[i] < 1e-18 ||
        areas[other] < 1e-18 ||
        Math.abs(normal.dot(normals[other])) < 0.998
      )
        continue;
      const delta = centers[i].clone().sub(centers[other]);
      if (
        Math.abs(delta.dot(normal)) > tolerance ||
        Math.abs(delta.dot(normals[other])) > tolerance
      )
        continue;
      parent[find(i)] = find(other);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const result: PlanarPatch[] = [];
  for (const faces of groups.values()) {
    if (faces.length < 8) continue;
    const seed =
        normals[
          faces.reduce(
            (best, i) => (areas[i] > areas[best] ? i : best),
            faces[0],
          )
        ],
      normal = new T.Vector3(),
      center = new T.Vector3();
    let area = 0;
    for (const f of faces) {
      normal.addScaledVector(
        normals[f],
        areas[f] * (normals[f].dot(seed) < 0 ? -1 : 1),
      );
      center.addScaledVector(centers[f], areas[f]);
      area += areas[f];
    }
    if (!area || normal.length() < area * 0.8) continue;
    normal.normalize();
    center.divideScalar(area);
    const axis = [
      Math.abs(normal.x),
      Math.abs(normal.y),
      Math.abs(normal.z),
    ].indexOf(
      Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)),
    );
    if (normal.getComponent(axis) < 0) normal.negate();
    const distances = faces
      .map((f) => Math.abs(centers[f].clone().sub(center).dot(normal)))
      .sort((a, b) => a - b);
    if (distances[Math.floor(distances.length * 0.9)] > tolerance) continue;
    result.push({ normal, area, faces: faces.map((f) => f * 3) });
  }
  return result.sort((a, b) => b.area - a.area).slice(0, 96);
}
