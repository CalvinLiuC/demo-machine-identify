import * as T from "three";
import type { GeometryItem, Vec3 } from "./types.ts";

export interface AxisCandidate {
  mesh: string;
  kind: "cylinder" | "principal" | "circle";
  direction: Vec3;
  point: Vec3;
  residual: number;
  radius?: number;
  evidence: string;
}

// Jacobi diagonalization for the symmetric 3×3 covariance matrix.
export function eigenvectors(c: number[][]): T.Vector3[] {
  const a = c.map((r) => [...r]),
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let iteration = 0; iteration < 24; iteration++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ])
      if (Math.abs(a[i][j]) > Math.abs(a[p][q])) {
        p = i;
        q = j;
      }
    if (Math.abs(a[p][q]) < 1e-14) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]),
      cs = Math.cos(angle),
      sn = Math.sin(angle);
    const app = a[p][p],
      aqq = a[q][q],
      apq = a[p][q];
    for (let k = 0; k < 3; k++)
      if (k !== p && k !== q) {
        const akp = a[k][p],
          akq = a[k][q];
        a[k][p] = a[p][k] = cs * akp - sn * akq;
        a[k][q] = a[q][k] = sn * akp + cs * akq;
      }
    a[p][p] = cs * cs * app - 2 * sn * cs * apq + sn * sn * aqq;
    a[q][q] = sn * sn * app + 2 * sn * cs * apq + cs * cs * aqq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      const vp = v[k][p],
        vq = v[k][q];
      v[k][p] = cs * vp - sn * vq;
      v[k][q] = sn * vp + cs * vq;
    }
  }
  return [0, 1, 2]
    .sort((i, j) => a[j][j] - a[i][i])
    .map((i) => new T.Vector3(v[0][i], v[1][i], v[2][i]).normalize());
}
function covariance(points: T.Vector3[], center: T.Vector3) {
  const c = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const p of points) {
    const d = p.clone().sub(center).toArray();
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) c[i][j] += (d[i] * d[j]) / points.length;
  }
  return c;
}
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++)
      if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    [m[pivot], m[i]] = [m[i], m[pivot]];
    if (Math.abs(m[i][i]) < 1e-12) return null;
    const d = m[i][i];
    for (let k = i; k < 4; k++) m[i][k] /= d;
    for (let j = 0; j < 3; j++)
      if (j !== i) {
        const v = m[j][i];
        for (let k = i; k < 4; k++) m[j][k] -= v * m[i][k];
      }
  }
  return m.map((r) => r[3]);
}
export function axisCandidates(item: GeometryItem): AxisCandidate[] {
  const g = item.geometry,
    position = g.getAttribute("position");
  if (!position || position.count < 6) return [];
  const points: T.Vector3[] = [];
  const unique = new Set<string>(),
    step = Math.max(1, Math.ceil(position.count / 12000));
  for (let i = 0; i < position.count; i += step) {
    const p = new T.Vector3().fromBufferAttribute(position, i),
      key = p
        .toArray()
        .map((n) => n.toPrecision(7))
        .join(",");
    if (!unique.has(key)) {
      points.push(p);
      unique.add(key);
    }
  }
  const center = points
      .reduce((s, p) => s.add(p), new T.Vector3())
      .divideScalar(points.length),
    axes = eigenvectors(covariance(points, center));
  const size = new T.Box3()
    .setFromPoints(points)
    .getSize(new T.Vector3())
    .length();
  const result: AxisCandidate[] = [
    {
      mesh: item.id,
      kind: "principal",
      direction: axes[0].toArray(),
      point: center.toArray(),
      residual: 0,
      evidence: "PCA 最大方差方向；仅为外形主轴，不是已确认运动轴。",
    },
  ];
  const candidates = [
    ...axes,
    new T.Vector3(1, 0, 0),
    new T.Vector3(0, 1, 0),
    new T.Vector3(0, 0, 1),
  ];
  for (const axis of candidates) {
    const seed =
        Math.abs(axis.z) < 0.8
          ? new T.Vector3(0, 0, 1)
          : new T.Vector3(0, 1, 0),
      u = new T.Vector3().crossVectors(axis, seed).normalize(),
      v = new T.Vector3().crossVectors(axis, u).normalize();
    const xy = points.map((p) => {
      const d = p.clone().sub(center);
      return [d.dot(u), d.dot(v)];
    });
    const a = Array.from({ length: 3 }, () => [0, 0, 0]),
      b = [0, 0, 0];
    for (const [x, y] of xy) {
      const row = [2 * x, 2 * y, 1],
        value = x * x + y * y;
      for (let i = 0; i < 3; i++) {
        b[i] += row[i] * value;
        for (let j = 0; j < 3; j++) a[i][j] += row[i] * row[j];
      }
    }
    const fit = solve3(a, b);
    if (!fit) continue;
    const [cx, cy, c] = fit,
      r = Math.sqrt(c + cx * cx + cy * cy);
    if (!Number.isFinite(r) || r < size * 0.005) continue;
    const distances = xy
      .map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r))
      .sort((a, b) => a - b);
    // Ignore up to 10% cap-center vertices, but reject flat / partial-circle fits.
    const residual = distances[Math.floor(distances.length * 0.9)],
      angles = new Set(
        xy
          .filter(
            ([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r) < r * 0.03,
          )
          .map(([x, y]) =>
            Math.floor(
              ((Math.atan2(y - cy, x - cx) + Math.PI) / (Math.PI * 2)) * 12,
            ),
          ),
      );
    const heights = points.map((p) => p.clone().sub(center).dot(axis)),
      span = Math.max(...heights) - Math.min(...heights);
    if (residual / r > 0.025 || angles.size < 10 || span < r * 0.1) continue;
    if (
      result.some(
        (c) =>
          c.kind === "cylinder" &&
          Math.abs(new T.Vector3(...c.direction).dot(axis)) > 0.99,
      )
    )
      continue;
    result.unshift({
      mesh: item.id,
      kind: "cylinder",
      direction: axis.toArray(),
      point: center
        .clone()
        .addScaledVector(u, cx)
        .addScaledVector(v, cy)
        .toArray(),
      radius: r,
      residual,
      evidence: `近完整圆柱表面拟合；90% 分位径向误差 ${(residual * 1000).toFixed(3)} mm。圆柱不一定是运动副。`,
    });
  }
  return result;
}
