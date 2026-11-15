import * as T from "three";
import type { GeometryItem, Vec3 } from "./types.ts";
import { adjacentPlanarPatches } from "./planar-regions.ts";

export interface CircleFeature {
  point: Vec3;
  axis: Vec3;
  radius: number;
  error: number;
  mesh: string;
  supportFaces: number;
  method?: "planar-face" | "outer-profile" | "bolt-pattern";
}
export interface SurfaceDescriptor {
  id: string;
  triangles: number;
  box: T.Box3;
  center: T.Vector3;
  size: T.Vector3;
  diagonal: number;
  area: number;
  planarCoverage: number;
  samples: T.Vector3[];
  circles: CircleFeature[];
  facets: T.Triangle[];
}
const point = (
  p: T.BufferAttribute | T.InterleavedBufferAttribute,
  i: number,
) => new T.Vector3().fromBufferAttribute(p, i);
function solve(a: number[][], b: number[]): number[] | null {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let j = i;
    for (let k = i + 1; k < 3; k++)
      if (Math.abs(m[k][i]) > Math.abs(m[j][i])) j = k;
    [m[i], m[j]] = [m[j], m[i]];
    if (Math.abs(m[i][i]) < 1e-15) return null;
    const d = m[i][i];
    for (let k = i; k < 4; k++) m[i][k] /= d;
    for (let j = 0; j < 3; j++)
      if (j !== i) {
        const d = m[j][i];
        for (let k = i; k < 4; k++) m[j][k] -= d * m[i][k];
      }
  }
  return m.map((r) => r[3]);
}
export function describeSurface(item: GeometryItem): SurfaceDescriptor {
  const original = item.geometry,
    input = original.index ? original.toNonIndexed() : original,
    p = input.getAttribute("position");
  original.computeBoundingBox();
  const box = original.boundingBox.clone(),
    center = box.getCenter(new T.Vector3()),
    size = box.getSize(new T.Vector3()),
    diagonal = size.length();
  const buckets = new Map<
      string,
      { normal: T.Vector3; area: number; faces: number[] }
    >(),
    normalBins = new Map<string, { normal: T.Vector3; area: number }>();
  const samples: T.Vector3[] = [],
    facets: T.Triangle[] = [],
    stride = Math.max(1, Math.ceil(p.count / 3 / 180));
  let area = 0;
  const planeTolerance = Math.max(diagonal * 2e-5, 1e-7);
  for (let i = 0; i < p.count; i += 3) {
    const a = point(p, i),
      b = point(p, i + 1),
      c = point(p, i + 2),
      n = b.clone().sub(a).cross(c.clone().sub(a)),
      faceArea = n.length() / 2;
    if (p.count / 3 <= 400) facets.push(new T.Triangle(a, b, c));
    if ((i / 3) % stride === 0) {
      samples.push(a, b, c, a.clone().add(b).add(c).divideScalar(3));
    }
    if (faceArea < 1e-18) continue;
    area += faceArea;
    n.normalize();
    const axis = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)].indexOf(
      Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)),
    );
    if (n.getComponent(axis) < 0) n.negate();
    const key = n
        .toArray()
        .map((v) => Math.round(v / 0.04))
        .join(","),
      bin = normalBins.get(key);
    if (bin) bin.area += faceArea;
    else normalBins.set(key, { normal: n.clone(), area: faceArea });
    const fine =
        n
          .toArray()
          .map((v) => Math.round(v / 0.006))
          .join(",") +
        ":" +
        Math.round(n.dot(a) / planeTolerance),
      bucket = buckets.get(fine);
    if (bucket) {
      bucket.area += faceArea;
      bucket.faces.push(i);
    } else buckets.set(fine, { normal: n, area: faceArea, faces: [i] });
  }
  const directions = [...normalBins.values()].sort((a, b) => b.area - a.area),
    used = new Set<number>();
  let planar = 0;
  for (let count = 0; count < 3; count++) {
    const seed = directions.find((_, i) => !used.has(i));
    if (!seed) break;
    directions.forEach((d, i) => {
      if (!used.has(i) && Math.abs(d.normal.dot(seed.normal)) > 0.985) {
        used.add(i);
        planar += d.area;
      }
    });
  }
  const circles: CircleFeature[] = [];
  const patches = [...buckets.values()]
    .filter((b) => b.faces.length >= 10 && b.area > area * 0.0003)
    .sort((a, b) => b.area - a.area)
    .slice(0, 64);
  patches.push(
    ...adjacentPlanarPatches(p, diagonal).filter((b) => b.area > area * 0.0003),
  );
  for (const patch of patches) {
    const normal = patch.normal,
      seed =
        Math.abs(normal.z) < 0.8
          ? new T.Vector3(0, 0, 1)
          : new T.Vector3(0, 1, 0),
      u = new T.Vector3().crossVectors(normal, seed).normalize(),
      v = new T.Vector3().crossVectors(normal, u).normalize();
    const edges = new Map<
        string,
        { count: number; a: T.Vector3; b: T.Vector3 }
      >(),
      q = (a: T.Vector3) =>
        a
          .toArray()
          .map((n) => Math.round(n / 1e-6))
          .join(",");
    for (const i of patch.faces) {
      const vertices = [point(p, i), point(p, i + 1), point(p, i + 2)];
      for (let k = 0; k < 3; k++) {
        const a = vertices[k],
          b = vertices[(k + 1) % 3],
          key = [q(a), q(b)].sort().join("|"),
          edge = edges.get(key);
        if (edge) edge.count++;
        else edges.set(key, { count: 1, a, b });
      }
    }
    const boundary = [...edges.values()]
      .filter((e) => e.count === 1)
      .flatMap((e) => [e.a, e.b]);
    if (boundary.length < 20) continue;
    const anchor = boundary[0],
      xy = boundary.map((p) => {
        const d = p.clone().sub(anchor);
        return [d.dot(u), d.dot(v)];
      });
    const xs = xy.map((p) => p[0]),
      ys = xy.map((p) => p[1]),
      cx = (Math.min(...xs) + Math.max(...xs)) / 2,
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radii = xy
        .map(([x, y]) => Math.hypot(x - cx, y - cy))
        .sort((a, b) => a - b),
      outer = radii[Math.floor(radii.length * 0.9)];
    if (outer < diagonal * 0.025 || outer > diagonal * 0.65) continue;
    const outerPoints = xy.filter(
        ([x, y]) => Math.hypot(x - cx, y - cy) > outer * 0.85,
      ),
      a = Array.from({ length: 3 }, () => [0, 0, 0]),
      b = [0, 0, 0];
    for (const [x, y] of outerPoints) {
      const row = [2 * x, 2 * y, 1],
        r = x * x + y * y;
      for (let j = 0; j < 3; j++) {
        b[j] += row[j] * r;
        for (let k = 0; k < 3; k++) a[j][k] += row[j] * row[k];
      }
    }
    const fit = solve(a, b);
    if (!fit) continue;
    const [x, y, d] = fit,
      r = Math.sqrt(d + x * x + y * y);
    if (!Number.isFinite(r)) continue;
    const residuals = outerPoints
        .map(([px, py]) => Math.abs(Math.hypot(px - x, py - y) - r))
        .sort((a, b) => a - b),
      error = residuals[Math.floor(residuals.length * 0.85)];
    const angular = new Set(
      outerPoints.map(([px, py]) =>
        Math.floor(
          ((Math.atan2(py - y, px - x) + Math.PI) / (Math.PI * 2)) * 12,
        ),
      ),
    );
    if (
      error > r * 0.025 ||
      angular.size < 10 ||
      patch.area / (Math.PI * r * r) < 0.12
    )
      continue;
    const location = anchor.clone().addScaledVector(u, x).addScaledVector(v, y);
    if (
      circles.some(
        (c) =>
          Math.abs(new T.Vector3(...c.axis).dot(normal)) > 0.99 &&
          new T.Vector3(...c.point).distanceTo(location) < r * 0.12,
      )
    )
      continue;
    circles.push({
      point: location.toArray(),
      axis: normal.toArray(),
      radius: r,
      error,
      mesh: item.id,
      supportFaces: patch.faces.length,
    });
  }
  if (input !== original) input.dispose();
  return {
    id: item.id,
    triangles: p.count / 3,
    box,
    center,
    size,
    diagonal,
    area,
    planarCoverage: area ? planar / area : 1,
    samples,
    circles,
    facets,
  };
}
export function boxGap(a: T.Box3, b: T.Box3): number {
  let sum = 0;
  for (const axis of ["x", "y", "z"] as const) {
    const gap = Math.max(
      0,
      a.min[axis] - b.max[axis],
      b.min[axis] - a.max[axis],
    );
    sum += gap * gap;
  }
  return Math.sqrt(sum);
}
export function surfaceGap(
  a: SurfaceDescriptor,
  b: SurfaceDescriptor,
): { distance: number; point: Vec3 } {
  let best = Infinity,
    pa = a.center,
    pb = b.center;
  for (const x of a.samples)
    for (const y of b.samples) {
      const d = x.distanceToSquared(y);
      if (d < best) {
        best = d;
        pa = x;
        pb = y;
      }
    }
  const projected = new T.Vector3();
  for (const [target, source] of [
    [a, b],
    [b, a],
  ])
    if (target.facets.length) {
      for (const p of source.samples) {
        if (target.box.distanceToPoint(p) ** 2 > best) continue;
        for (const triangle of target.facets) {
          triangle.closestPointToPoint(p, projected);
          const d = p.distanceToSquared(projected);
          if (d < best) {
            best = d;
            pa = p;
            pb = projected.clone();
          }
        }
      }
    }
  return {
    distance: Math.sqrt(best),
    point: pa.clone().add(pb).multiplyScalar(0.5).toArray(),
  };
}
