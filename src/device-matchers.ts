import * as T from "three";
import { eigenvectors } from "./geometry.ts";
import { fitPointCircle, axisLineDistance } from "./interface-patterns.ts";
import {
  boxGap,
  type SurfaceDescriptor,
  type CircleFeature,
} from "./surface-features.ts";
import type { DeviceProposal, ProposedJoint } from "./scene-analysis.ts";

interface Rotor {
  body: SurfaceDescriptor;
  circle: CircleFeature;
  thickness: number;
}
type Gap = (a: SurfaceDescriptor, b: SurfaceDescriptor) => { distance: number };
function disk(d: SurfaceDescriptor, scale: number): Rotor | null {
  if (d.samples.length < 12 || d.diagonal < scale * 0.025) return null;
  const center = d.center.clone(),
    cov = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const p of d.samples) {
    const delta = p.clone().sub(center).toArray();
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) cov[i][j] += delta[i] * delta[j];
  }
  const axis = eigenvectors(cov)[2];
  const largest = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)],
    major = largest.indexOf(Math.max(...largest));
  if (largest[major] > 0.9995) {
    axis.set(0, 0, 0);
    axis.setComponent(major, 1);
  }
  const projections = d.samples.map((p) => p.clone().sub(center).dot(axis)),
    height = Math.max(...projections) - Math.min(...projections);
  const radial = d.samples
      .map((p) => {
        const delta = p.clone().sub(center);
        return delta.addScaledVector(axis, -delta.dot(axis)).length();
      })
      .sort((a, b) => a - b),
    radius = radial[Math.floor(radial.length * 0.9)];
  if (radius < scale * 0.06 || height > radius * 0.8) return null;
  const outer = d.samples.filter((p) => {
    const delta = p.clone().sub(center);
    return (
      delta.addScaledVector(axis, -delta.dot(axis)).length() > radius * 0.94
    );
  });
  const flattened = outer.map((p) =>
    p.clone().addScaledVector(axis, -p.clone().sub(center).dot(axis)),
  );
  const fit = fitPointCircle(flattened);
  if (!fit || fit.error > fit.radius * 0.055) return null;
  const normal = new T.Vector3(...fit.axis),
    seed =
      Math.abs(normal.z) < 0.8
        ? new T.Vector3(0, 0, 1)
        : new T.Vector3(0, 1, 0),
    u = new T.Vector3().crossVectors(normal, seed).normalize(),
    v = new T.Vector3().crossVectors(normal, u),
    origin = new T.Vector3(...fit.point);
  const angles = new Set(
    outer.map((p) => {
      const d = p.clone().sub(origin);
      return Math.floor(
        ((Math.atan2(d.dot(v), d.dot(u)) + Math.PI) / (2 * Math.PI)) * 12,
      );
    }),
  );
  if (angles.size < 10) return null;
  return {
    body: d,
    circle: {
      mesh: d.id,
      point: fit.point,
      axis: fit.axis,
      radius: fit.radius,
      error: fit.error,
      supportFaces: outer.length,
      method: "outer-profile",
    },
    thickness: height,
  };
}
function rotorJoint(
  base: SurfaceDescriptor,
  rotor: Rotor,
  scale: number,
): ProposedJoint {
  const c = rotor.circle,
    n = new T.Vector3(...c.axis);
  const profile = disk(base, scale)?.circle;
  const match = [...base.circles, ...(profile ? [profile] : [])].find(
    (b) =>
      Math.abs(new T.Vector3(...b.axis).dot(n)) > 0.98 &&
      axisLineDistance(b.point, c.point, c.axis) < c.radius * 0.08 &&
      b.radius / c.radius > 0.45 &&
      b.radius / c.radius < 2.2,
  );
  return {
    origin: c.point,
    axis: c.axis,
    status: "candidate",
    support: match ? "two-sided" : "one-sided",
    alternatives: [c, ...(match ? [match] : [])],
    evidence: [
      "薄圆盘外轮廓与较厚支撑/壳体邻接，按回转工作台构型生成候选。",
      match
        ? "支撑体上存在同轴圆形几何。"
        : "支撑体未找到独立同轴端面，转轴仅由工作台外轮廓推断。",
      `工作台外轮廓半径 ${(c.radius * 1000).toFixed(2)} mm，拟合误差 ${(c.error * 1000).toFixed(3)} mm。`,
      "外观不能证明内部驱动、机械限位和零位，需确认该圆盘实际能够转动。",
    ],
  };
}
export function matchPositioners(
  ds: SurfaceDescriptor[],
  used: Set<string>,
  scale: number,
  gap: Gap,
): DeviceProposal[] {
  const available = ds.filter((d) => !used.has(d.id)),
    rotors = available
      .map((d) => disk(d, scale))
      .filter((d): d is Rotor => !!d),
    options: { proposal: DeviceProposal; score: number; ids: string[] }[] = [];
  for (const rotor of rotors) {
    const n = new T.Vector3(...rotor.circle.axis),
      origin = new T.Vector3(...rotor.circle.point),
      radius = rotor.circle.radius;
    const supports = available.filter((base) => {
      const projections = base.samples.map((p) => p.dot(n)),
        span = Math.max(...projections) - Math.min(...projections),
        offset = Math.abs(origin.clone().sub(base.center).dot(n));
      return (
        base.id !== rotor.body.id &&
        base.diagonal > rotor.body.diagonal * 0.65 &&
        span > radius * 0.24 &&
        radius / base.diagonal > 0.17 &&
        offset > span * 0.18 &&
        boxGap(base.box, rotor.body.box) < scale * 0.014 &&
        axisLineDistance(
          base.center.toArray(),
          rotor.circle.point,
          rotor.circle.axis,
        ) <
          radius * 0.7 &&
        gap(base, rotor.body).distance < Math.max(scale * 0.015, radius * 0.12)
      );
    });
    for (const support of supports) {
      const inner = rotorJoint(support, rotor, scale);
      const roots = available.filter(
        (root) =>
          root.id !== support.id &&
          root.id !== rotor.body.id &&
          root.planarCoverage > 0.6 &&
          root.diagonal > support.diagonal * 0.6 &&
          root.box.min.z < support.center.z - support.diagonal * 0.08 &&
          boxGap(root.box, support.box) < scale * 0.012 &&
          gap(root, support).distance < scale * 0.015,
      );
      let dual = false;
      for (const root of roots) {
        const outerPairs = root.circles.flatMap((a) =>
          support.circles
            .filter(
              (b) =>
                Math.abs(
                  new T.Vector3(...a.axis).dot(new T.Vector3(...b.axis)),
                ) > 0.98 &&
                axisLineDistance(a.point, b.point, b.axis) <
                  Math.min(a.radius, b.radius) * 0.1 &&
                Math.abs(new T.Vector3(...a.axis).dot(n)) < 0.25,
            )
            .map((b) => ({ a, b })),
        );
        const pair = outerPairs[0];
        if (!pair) continue;
        const outer: ProposedJoint = {
          origin: pair.a.point,
          axis: pair.a.axis,
          status: "candidate",
          support: "two-sided",
          alternatives: [pair.a, pair.b],
          evidence: [
            "底座与倾转架有同轴端面，倾转轴与工作台轴近似垂直；形成串联双 R 变位机候选。",
            "内部联动、零位与限位尚未恢复。",
          ],
        };
        options.push({
          proposal: {
            id: "",
            kind: "positioner",
            template: "positioner_2R",
            name: "双轴变位机候选",
            links: [
              { anchor: root.id, meshIds: [root.id] },
              { anchor: support.id, meshIds: [support.id], joint: outer },
              { anchor: rotor.body.id, meshIds: [rotor.body.id], joint: inner },
            ],
            evidence: ["回转工作台、倾转架和支撑体形成两个近似正交回转副。"],
          },
          score: -10 + gap(root, support).distance,
          ids: [root.id, support.id, rotor.body.id],
        });
        dual = true;
      }
      if (
        !dual &&
        (inner.support === "two-sided" ||
          (support.planarCoverage > 0.95 && Math.abs(n.z) > 0.9) ||
          (support.triangles > 2000 && radius / support.diagonal > 0.25))
      )
        options.push({
          proposal: {
            id: "",
            kind: "positioner",
            template: "positioner_1R",
            name: "单轴变位机候选",
            links: [
              { anchor: support.id, meshIds: [support.id] },
              { anchor: rotor.body.id, meshIds: [rotor.body.id], joint: inner },
            ],
            evidence: [
              "圆盘工作面与支撑壳体匹配单 R 工作台模板；可能为变位机/回转台，分类和运动均待确认。",
            ],
          },
          score:
            rotor.thickness / radius +
            gap(support, rotor.body).distance / radius,
          ids: [support.id, rotor.body.id],
        });
    }
  }
  options.sort((a, b) => a.score - b.score);
  const result: DeviceProposal[] = [];
  for (const option of options) {
    if (option.ids.some((id) => used.has(id))) continue;
    option.ids.forEach((id) => used.add(id));
    option.proposal.id = `positioner_${result.length}`;
    result.push(option.proposal);
  }
  return result;
}

export function matchGrippers(
  robots: DeviceProposal[],
  ds: SurfaceDescriptor[],
  used: Set<string>,
  scale: number,
  gap: Gap,
): DeviceProposal[] {
  const results: DeviceProposal[] = [];
  for (const robot of robots) {
    const output = robot.links.at(-1),
      joint = output.joint;
    if (!joint?.axis) continue;
    const anchor = ds.find((d) => d.id === output.anchor),
      point = new T.Vector3(...joint.origin),
      n = new T.Vector3(...joint.axis);
    const bodies = ds.filter(
      (d) =>
        !used.has(d.id) &&
        d.diagonal > anchor.diagonal * 0.3 &&
        d.diagonal < anchor.diagonal * 0.85 &&
        d.center.distanceTo(point) < anchor.diagonal * 0.7 &&
        d.circles.some(
          (c) =>
            Math.abs(new T.Vector3(...c.axis).dot(n)) > 0.97 &&
            axisLineDistance(c.point, joint.origin, joint.axis) <
              anchor.diagonal * 0.035,
        ),
    );
    bodies.sort(
      (a, b) => a.center.distanceTo(point) - b.center.distanceTo(point),
    );
    for (const body of bodies) {
      const jaws = ds
        .filter(
          (d) =>
            !used.has(d.id) &&
            d.id !== body.id &&
            d.diagonal > body.diagonal * 0.45 &&
            d.diagonal < body.diagonal * 1.5 &&
            boxGap(d.box, body.box) < scale * 0.006 &&
            gap(d, body).distance < scale * 0.012,
        )
        .sort(
          (a, b) =>
            a.center.distanceTo(body.center) - b.center.distanceTo(body.center),
        );
      if (jaws.length < 2) continue;
      const [left, right] = jaws;
      if (left.center.distanceTo(right.center) < body.diagonal * 0.08) continue;
      const proposal: DeviceProposal = {
        id: `gripper_${results.length}`,
        kind: "gripper",
        template: "gripper_candidate",
        name: "末端夹爪候选",
        parentProposal: robot.id,
        parentLinkIndex: robot.links.length - 1,
        links: [
          { anchor: body.id, meshIds: [body.id] },
          ...jaws.slice(0, 2).map((d) => ({
            anchor: d.id,
            meshIds: [d.id],
            parentIndex: 0,
            joint: {
              origin: d.center.toArray(),
              status: "unresolved" as const,
              support: "none" as const,
              alternatives: [] as CircleFeature[],
              evidence: [
                "夹爪外形与双侧构件候选；单姿态不足以确认平移、转动或固定附件，暂固定显示。",
              ],
            },
          })),
        ],
        evidence: [
          "末端圆形接口与机器人输出法兰候选共轴，周围存在双侧尺寸相近构件，作为独立夹爪候选。",
          "安装关系是几何/构型推断；指爪运动类型与联动未知，没有自动生成虚假的 P / mimic 关节。",
        ],
      };
      proposal.links.forEach((l) => used.add(l.anchor));
      results.push(proposal);
      break;
    }
  }
  return results;
}
