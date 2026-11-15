import * as T from "three";
import type { GeometryItem } from "./types.ts";

/** Position welding is only for connectivity; original triangles are never moved. */
export function splitComponents(
  item: GeometryItem,
  tolerance = 1e-6,
): GeometryItem[] {
  const input = item.geometry.index
    ? item.geometry.toNonIndexed()
    : item.geometry;
  const p = input.getAttribute("position"),
    count = p.count / 3;
  const parent = new Int32Array(count),
    rank = new Uint8Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const vertices = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) / tolerance)},${Math.round(p.getY(i) / tolerance)},${Math.round(p.getZ(i) / tolerance)}`;
    const triangle = Math.floor(i / 3),
      previous = vertices.get(key);
    if (previous === undefined) {
      vertices.set(key, triangle);
      continue;
    }
    let a = find(triangle),
      b = find(previous);
    if (a === b) continue;
    if (rank[a] < rank[b]) [a, b] = [b, a];
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const result = [...groups.values()].map((triangles, index) => {
    const positions = new Float32Array(triangles.length * 9),
      ranges: [number, number][] = [];
    let offset = 0;
    for (const triangle of triangles) {
      const last = ranges.at(-1);
      if (last && last[0] + last[1] === triangle) last[1]++;
      else ranges.push([triangle, 1]);
      for (let k = 0; k < 3; k++) {
        const v = triangle * 3 + k;
        positions[offset++] = p.getX(v);
        positions[offset++] = p.getY(v);
        positions[offset++] = p.getZ(v);
      }
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return {
      ...item,
      id: `${item.id}_part_${index}`,
      name: `几何分量 ${index + 1}`,
      geometry,
      source: {
        original: item.source,
        component: index,
        triangleRanges: ranges,
        weldTolerance: tolerance,
      },
    };
  });
  if (input !== item.geometry) input.dispose();
  return result;
}
