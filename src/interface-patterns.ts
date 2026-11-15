import * as T from "three";
import { eigenvectors } from "./geometry.ts";
import type { SurfaceDescriptor, CircleFeature } from "./surface-features.ts";
import type { ProposedJoint } from "./scene-analysis.ts";
import type { Vec3 } from "./types.ts";

export function fitPointCircle(points: T.Vector3[]): {
  point: Vec3;
  axis: Vec3;
  radius: number;
  error: number;
  planeError: number;
} | null {
  if (points.length < 5) return null;
  const center = points
      .reduce((s, p) => s.add(p), new T.Vector3())
      .divideScalar(points.length),
    cov = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const p of points) {
    const d = p.clone().sub(center).toArray();
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const [u, v, normal] = eigenvectors(cov),
    xy = points.map((p) => {
      const d = p.clone().sub(center);
      return [d.dot(u), d.dot(v)];
    });
  let xx = 0,
    xySum = 0,
    yy = 0,
    bx = 0,
    by = 0;
  for (const [x, y] of xy) {
    const r = x * x + y * y;
    xx += x * x;
    xySum += x * y;
    yy += y * y;
    bx += (x * r) / 2;
    by += (y * r) / 2;
  }
  const det = xx * yy - xySum * xySum;
  if (Math.abs(det) < 1e-16) return null;
  const x = (bx * yy - by * xySum) / det,
    y = (by * xx - bx * xySum) / det,
    origin = center.clone().addScaledVector(u, x).addScaledVector(v, y);
  const radii = points.map((p) => p.distanceTo(origin)).sort((a, b) => a - b),
    radius = radii[Math.floor(radii.length / 2)];
  const error = Math.max(...radii.map((r) => Math.abs(r - radius))),
    planeError = Math.max(
      ...points.map((p) => Math.abs(p.clone().sub(origin).dot(normal))),
    );
  const angles = xy
      .map(([px, py]) => Math.atan2(py - y, px - x))
      .sort((a, b) => a - b),
    gaps = angles.map((a, i) =>
      i ? a - angles[i - 1] : a + Math.PI * 2 - angles.at(-1),
    );
  if (Math.max(...gaps) > Math.PI * 0.85) return null;
  return {
    point: origin.toArray(),
    axis: normal.toArray(),
    radius,
    error,
    planeError,
  };
}

export function axisLineDistance(
  point: Vec3,
  origin: Vec3,
  axis: Vec3,
): number {
  const delta = new T.Vector3(...point).sub(new T.Vector3(...origin)),
    n = new T.Vector3(...axis).normalize();
  return delta.addScaledVector(n, -delta.dot(n)).length();
}
export function wristCenter(
  a: ProposedJoint,
  b: ProposedJoint,
): { point: Vec3; error: number } | null {
  if (!a?.axis || !b?.axis) return null;
  const u = new T.Vector3(...a.axis),
    v = new T.Vector3(...b.axis),
    delta = new T.Vector3(...a.origin).sub(new T.Vector3(...b.origin)),
    dot = u.dot(v),
    det = 1 - dot * dot;
  if (det < 0.25) return null;
  const d = u.dot(delta),
    e = v.dot(delta),
    x = new T.Vector3(...a.origin).addScaledVector(u, (dot * e - d) / det),
    y = new T.Vector3(...b.origin).addScaledVector(v, (e - dot * d) / det);
  return {
    point: x.clone().add(y).multiplyScalar(0.5).toArray(),
    error: x.distanceTo(y),
  };
}

export function flangeBoltPattern(
  body: SurfaceDescriptor,
  descriptors: SurfaceDescriptor[],
  roll: ProposedJoint,
  tilt: ProposedJoint,
  scale: number,
): { joint: ProposedJoint; boltIds: string[] } | null {
  const intersection = wristCenter(roll, tilt);
  if (!intersection || intersection.error > scale * 0.006) return null;
  const candidates = descriptors.filter(
    (d) =>
      d.id !== body.id &&
      d.triangles >= 24 &&
      d.diagonal < body.diagonal * 0.22 &&
      d.box.distanceToPoint(body.center) < body.diagonal * 0.8,
  );
  const groups: SurfaceDescriptor[][] = [];
  for (const d of candidates) {
    const dims = d.size.toArray().sort((a, b) => a - b),
      group = groups.find((g) => {
        const reference = g[0],
          other = reference.size.toArray().sort((a, b) => a - b);
        return (
          d.triangles / reference.triangles > 0.8 &&
          d.triangles / reference.triangles < 1.25 &&
          dims.every(
            (v, i) => Math.abs(v - other[i]) < Math.max(v, other[i]) * 0.18,
          )
        );
      });
    if (group) group.push(d);
    else groups.push([d]);
  }
  const raw = groups
    .filter((g) => g.length >= 5 && g.length <= 36)
    .flatMap((g) => {
      const fit = fitPointCircle(g.map((d) => d.center));
      if (
        fit &&
        fit.error < fit.radius * 0.1 &&
        fit.planeError < fit.radius * 0.08
      )
        return [{ g, fit }];
      const hypotheses: {
        g: SurfaceDescriptor[];
        fit: ReturnType<typeof fitPointCircle>;
      }[] = [];
      let attempts = 0;
      const search = (indices: number[], start: number) => {
        if (attempts >= 800) return;
        if (indices.length === 5) {
          attempts++;
          const initial = fitPointCircle(indices.map((i) => g[i].center));
          if (!initial) return;
          const normal = new T.Vector3(...initial.axis),
            center = new T.Vector3(...initial.point);
          const inliers = g.filter(
            (d) =>
              Math.abs(d.center.clone().sub(center).dot(normal)) <
                Math.max(initial.radius * 0.07, scale * 0.0002) &&
              Math.abs(d.center.distanceTo(center) - initial.radius) <
                Math.max(initial.radius * 0.08, scale * 0.0003),
          );
          if (inliers.length >= 5)
            hypotheses.push({
              g: inliers,
              fit: fitPointCircle(inliers.map((d) => d.center)),
            });
          return;
        }
        for (let i = start; i < g.length; i++) search([...indices, i], i + 1);
      };
      search([], 0);
      return hypotheses;
    });
  const outward = body.center.clone().sub(new T.Vector3(...intersection.point));
  const fits = raw.filter(
    ({ fit }) =>
      fit &&
      new T.Vector3(...fit.point)
        .sub(new T.Vector3(...intersection.point))
        .dot(outward) > 0 &&
      new T.Vector3(...fit.point).distanceTo(body.center) <
        body.diagonal * 0.55 &&
      fit.radius > body.diagonal * 0.035 &&
      fit.radius < body.diagonal * 0.45 &&
      fit.error < fit.radius * 0.1 &&
      fit.planeError < fit.radius * 0.08 &&
      Math.abs(new T.Vector3(...fit.axis).dot(new T.Vector3(...tilt.axis))) <
        0.25 &&
      axisLineDistance(intersection.point, fit.point, fit.axis) <
        Math.max(scale * 0.004, fit.radius * 0.35),
  );
  fits.sort((a, b) => b.g.length - a.g.length || a.fit.error - b.fit.error);
  const best = fits[0];
  if (!best) return null;
  const { fit, g } = best;
  const feature: CircleFeature = {
    point: fit.point,
    axis: fit.axis,
    radius: fit.radius,
    error: fit.error,
    mesh: g[0].id,
    supportFaces: g.length,
    method: "bolt-pattern",
  };
  return {
    boltIds: g.map((d) => d.id),
    joint: {
      origin: fit.point,
      axis: fit.axis,
      status: "candidate",
      support: "one-sided",
      alternatives: [feature],
      evidence: [
        `${g.length} 个重复紧固件中心形成近共面孔阵列；圆拟合误差 ${(fit.error * 1000).toFixed(3)} mm。`,
        `输出轴线与前两腕轴参考交点距离 ${(axisLineDistance(intersection.point, fit.point, fit.axis) * 1000).toFixed(3)} mm；该偏差尚未校准，保留为模板推断。`,
        "孔阵列法向与腕部前两轴交点相容；使用 6R 球腕模板推断末轴，仍须运动或型号资料确认。",
        "末轴输出采用无可视几何的法兰 link；工具保留独立设备，不把工具本体当作机器人连杆。",
      ],
    },
  };
}
