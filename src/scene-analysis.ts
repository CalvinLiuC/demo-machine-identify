import * as T from "three";
import { splitComponents } from "./topology.ts";
import {
  describeSurface,
  boxGap,
  surfaceGap,
  type SurfaceDescriptor,
  type CircleFeature,
} from "./surface-features.ts";
import { bindAt, validate } from "./model.ts";
import type { Project, Vec3 } from "./types.ts";
import { flangeBoltPattern, axisLineDistance } from "./interface-patterns.ts";
import { eigenvectors } from "./geometry.ts";
import { matchPositioners, matchGrippers } from "./device-matchers.ts";

export interface ProposedJoint {
  origin: Vec3;
  axis?: Vec3;
  status: "candidate" | "unresolved";
  support: "two-sided" | "one-sided" | "none";
  alternatives: CircleFeature[];
  evidence: string[];
}
export interface ProposedLink {
  anchor: string;
  meshIds: string[];
  joint?: ProposedJoint;
  virtual?: boolean;
  parentIndex?: number;
}
export interface DeviceProposal {
  id: string;
  kind: "articulated" | "positioner" | "gripper" | "static" | "unknown";
  template?: string;
  parentProposal?: string;
  parentLinkIndex?: number;
  name: string;
  links: ProposedLink[];
  evidence: string[];
}
export interface SceneAnalysis {
  version: 1;
  sourceMeshCount: number;
  componentCount: number;
  triangles: number;
  tolerance: number;
  circleCount: number;
  ambiguousMeshes: string[];
  devices: DeviceProposal[];
  warnings: string[];
  revision?: string;
  algorithmVersion?: string;
}
export type Progress = (message: string, percent: number) => void;
export const ANALYSIS_VERSION = "geometry-0.4";

function baseShapeScore(body: SurfaceDescriptor, largest: number): number {
  const center = body.samples
      .reduce((s, p) => s.add(p), new T.Vector3())
      .divideScalar(body.samples.length),
    cov = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (const p of body.samples) {
    const d = p.clone().sub(center).toArray();
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const spans = eigenvectors(cov)
    .map((axis) => {
      const values = body.samples.map((p) => p.dot(axis));
      return Math.max(...values) - Math.min(...values);
    })
    .sort((a, b) => a - b);
  return (
    (1.5 * spans[0]) / Math.max(spans[2], 1e-9) +
    (0.6 * body.diagonal) / largest
  );
}

export function decomposeScene(
  p: Project,
  progress: Progress = () => {},
): number {
  const count = p.meshes.length,
    result: Project["meshes"] = [];
  p.meshes.forEach((m, i) => {
    progress(`拆分几何 ${i + 1}/${count}`, 10 + (i / count) * 20);
    result.push(...splitComponents(m));
  });
  p.meshes.forEach((m) => m.geometry.dispose());
  p.meshes = result;
  return count;
}

export function chooseJoint(
  a: SurfaceDescriptor,
  b: SurfaceDescriptor,
  scale: number,
): ProposedJoint {
  const contact = surfaceGap(a, b),
    all = [...a.circles, ...b.circles];
  const ranked = all
    .filter((c) => c.radius > Math.min(a.diagonal, b.diagonal) * 0.055)
    .map((c) => {
      const point = new T.Vector3(...c.point),
        axis = new T.Vector3(...c.axis);
      const other = c.mesh === a.id ? b : a;
      const partner = other.circles.find((d) => {
        if (Math.abs(new T.Vector3(...d.axis).dot(axis)) < 0.98) return false;
        const delta = new T.Vector3(...d.point).sub(point),
          radial = delta
            .clone()
            .addScaledVector(axis, -delta.dot(axis))
            .length();
        return (
          radial < Math.max(scale * 0.001, c.radius * 0.06) &&
          delta.length() < Math.max(a.diagonal, b.diagonal) * 0.6 &&
          d.radius / c.radius > 0.3 &&
          d.radius / c.radius < 3.3
        );
      });
      const gap = a.box.distanceToPoint(point) + b.box.distanceToPoint(point),
        distance = point.distanceTo(new T.Vector3(...contact.point));
      const score = gap + distance * 0.15 + (partner ? 0 : scale * 0.035);
      return { c, partner, score, gap };
    })
    .filter((x) => x.gap < Math.min(a.diagonal, b.diagonal) * 0.3)
    .sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (!best)
    return {
      origin: contact.point,
      status: "unresolved",
      support: "none",
      alternatives: [],
      evidence: ["未发现足够的局部圆形端面证据；暂时固定显示，运动副待定义。"],
    };
  const origin = best.partner
    ? new T.Vector3(...best.c.point)
        .add(new T.Vector3(...best.partner.point))
        .multiplyScalar(0.5)
        .toArray()
    : best.c.point;
  return {
    origin,
    axis: best.c.axis,
    status: "candidate",
    support: best.partner ? "two-sided" : "one-sided",
    alternatives: ranked.slice(0, 6).map((r) => r.c),
    evidence: [
      best.partner
        ? "相邻主体存在方向与轴线位置相容的两侧圆形端面。"
        : "仅从一侧主体提取到局部圆形端面；转动副假设较弱。",
      `圆形端面半径 ${(best.c.radius * 1000).toFixed(2)} mm；拟合误差 ${(best.c.error * 1000).toFixed(3)} mm。`,
      "关节类型、方向正负、连杆归属与顺序仍需确认；导入姿态仅为建模零位。",
    ],
  };
}

export function coaxialJoints(
  a: ProposedJoint | undefined,
  b: ProposedJoint | undefined,
  scale: number,
): boolean {
  if (!a?.axis || !b?.axis) return false;
  const axis = new T.Vector3(...a.axis).normalize();
  if (Math.abs(axis.dot(new T.Vector3(...b.axis).normalize())) < 0.995)
    return false;
  const d = new T.Vector3(...b.origin).sub(new T.Vector3(...a.origin));
  return (
    d.clone().addScaledVector(axis, -d.dot(axis)).length() < scale * 0.0015
  );
}

function thinAlong(d: SurfaceDescriptor, axis: Vec3): boolean {
  const n = new T.Vector3(...axis),
    projections = d.samples.map((p) => p.dot(n));
  const span = Math.max(...projections) - Math.min(...projections);
  return span < d.diagonal * 0.4;
}

export function recognizeScene(
  p: Project,
  sourceMeshCount = p.meshes.length,
  progress: Progress = () => {},
): SceneAnalysis {
  const descriptors = p.meshes.map((m, i) => {
    if (i % 8 === 0)
      progress(
        `提取局部表面 ${i + 1}/${p.meshes.length}`,
        35 + (i / p.meshes.length) * 35,
      );
    return describeSurface(m);
  });
  const byId = new Map(descriptors.map((d) => [d.id, d])),
    bounds = new T.Box3();
  descriptors.forEach((d) => bounds.union(d.box));
  const scale = Math.max(bounds.getSize(new T.Vector3()).length(), 1e-6),
    near = scale * 0.009;
  const cache = new Map<string, ReturnType<typeof surfaceGap>>();
  const gap = (a: SurfaceDescriptor, b: SurfaceDescriptor) => {
    const key = [a.id, b.id].sort().join("|");
    if (!cache.has(key)) cache.set(key, surfaceGap(a, b));
    return cache.get(key);
  };
  const components = (
    items: SurfaceDescriptor[],
    tolerance: number,
  ): SurfaceDescriptor[][] => {
    const result: SurfaceDescriptor[][] = [],
      remaining = new Set(items);
    while (remaining.size) {
      const first = remaining.values().next().value,
        group = [first];
      remaining.delete(first);
      for (let k = 0; k < group.length; k++)
        for (const d of remaining) {
          if (boxGap(group[k].box, d.box) > tolerance) continue;
          if (gap(group[k], d).distance < tolerance) {
            group.push(d);
            remaining.delete(d);
          }
        }
      result.push(group);
    }
    return result;
  };
  const devices: DeviceProposal[] = [],
    suppressedCovers = new Set<string>(),
    usedAnchors = new Set<string>(),
    seedGroups = components(
      descriptors.filter(
        (d) =>
          d.diagonal > scale * 0.07 &&
          d.planarCoverage < 0.86 &&
          d.triangles >= 64,
      ),
      near,
    );
  progress("匹配串联机构与静态结构候选", 75);
  for (const group of seedGroups) {
    if (group.length < 4 || group.length > 18) continue;
    const directions: T.Vector3[] = [];
    for (const c of group.flatMap((d) => d.circles)) {
      const axis = new T.Vector3(...c.axis);
      if (directions.every((a) => Math.abs(a.dot(axis)) < 0.9))
        directions.push(axis);
    }
    if (directions.length < 2) continue;
    const largest = Math.max(...group.map((d) => d.diagonal));
    const neighbors = new Map(
      group.map((d) => [
        d.id,
        group.filter(
          (other) =>
            other !== d &&
            boxGap(d.box, other.box) < near &&
            gap(d, other).distance < near,
        ),
      ]),
    );
    const roots = group
      .filter((d) => d.diagonal > largest * 0.4)
      .sort((a, b) => {
        const score = (d: SurfaceDescriptor) =>
          baseShapeScore(d, largest) -
          (neighbors.get(d.id).length === 1 ? 0 : 1);
        return score(b) - score(a);
      })
      .slice(0, 6);
    // Search from plausible graph ends, rather than selecting a root by gravity.
    // Otherwise a Y-up interpretation or wall-mounted robot loses its base/J1.
    let best: SurfaceDescriptor[] = [],
      bestCost = Infinity,
      visits = 0;
    const search = (path: SurfaceDescriptor[], cost: number) => {
      if (++visits > 12000) return;
      if (
        path.length > best.length ||
        (path.length === best.length && cost < bestCost)
      ) {
        best = [...path];
        bestCost = cost;
      }
      for (const next of neighbors.get(path.at(-1).id)) {
        if (path.includes(next)) continue;
        const d = gap(path.at(-1), next).distance;
        if (d < near) search([...path, next], cost + d);
      }
    };
    for (const root of roots) {
      visits = 0;
      const first = neighbors.get(root.id)[0],
        joint = first ? chooseJoint(root, first, scale) : undefined;
      const axisPenalty = joint?.axis
        ? axisLineDistance(root.center.toArray(), joint.origin, joint.axis) /
          root.diagonal
        : 1;
      const priority =
        baseShapeScore(root, largest) -
        (neighbors.get(root.id).length === 1 ? 0 : 1) -
        axisPenalty;
      search([root], -priority * near);
    }
    if (best.length < 3) continue;
    let chain = best.map((d, i) => ({
      body: d,
      joint: i ? chooseJoint(best[i - 1], d, scale) : undefined,
    }));
    for (let i = 2; i < chain.length; i++) {
      const cover = chain[i - 1],
        next = chain[i],
        previous = chain[i - 2];
      if (
        coaxialJoints(cover.joint, next.joint, scale) &&
        cover.body.diagonal <
          Math.min(previous.body.diagonal, next.body.diagonal) * 0.7 &&
        thinAlong(cover.body, cover.joint.axis)
      ) {
        next.joint = {
          ...cover.joint,
          evidence: [
            ...cover.joint.evidence,
            "中间薄盖与相邻运动副共轴，仅保留一个关节；薄盖归属保留待确认。",
          ],
        };
        suppressedCovers.add(cover.body.id);
        chain.splice(i - 1, 1);
        i--;
      }
    }
    best = chain.map((c) => c.body);
    // Smaller wrist/flange bodies can complete a chain. Require a geometric axis
    // interface, reject large planar fixtures, and never force a six-axis count.
    for (
      let extension = 0;
      extension < 4 && chain.filter((c) => c.joint?.axis).length < 6;
      extension++
    ) {
      const tip = best.at(-1),
        previous = best.at(-2);
      const candidates = descriptors
        .filter(
          (d) =>
            !best.includes(d) &&
            !usedAnchors.has(d.id) &&
            !suppressedCovers.has(d.id) &&
            d.diagonal < tip.diagonal * 0.7 &&
            d.diagonal > scale * 0.018 &&
            d.planarCoverage < 0.85 &&
            d.triangles >= 60 &&
            boxGap(tip.box, d.box) < near,
        )
        .map((d) => ({
          d,
          distance: gap(tip, d).distance,
          joint: chooseJoint(tip, d, scale),
        }))
        .filter(
          (c) =>
            c.distance < near &&
            c.joint.axis &&
            !coaxialJoints(chain.at(-1).joint, c.joint, scale) &&
            c.d.center.distanceTo(previous.center) >
              c.d.center.distanceTo(tip.center),
        )
        .sort((a, b) => a.distance - b.distance);
      if (!candidates.length) break;
      best.push(candidates[0].d);
      chain.push({ body: candidates[0].d, joint: candidates[0].joint });
    }
    if (chain.filter((c) => c.joint?.axis).length < 3) continue;
    const links: ProposedLink[] = chain.map(({ body: d, joint }) => ({
      anchor: d.id,
      meshIds: [d.id],
      joint,
    }));
    if (links.filter((l) => l.joint?.axis).length === 5) {
      const flange = flangeBoltPattern(
        best.at(-1),
        descriptors,
        links.at(-2).joint,
        links.at(-1).joint,
        scale,
      );
      if (flange)
        links.push({
          anchor: best.at(-1).id,
          meshIds: [],
          virtual: true,
          joint: flange.joint,
        });
    }
    best.forEach((d) => usedAnchors.add(d.id));
    devices.push({
      id: `articulated_${devices.length}`,
      kind: "articulated",
      name: "串联机器人候选",
      links,
      evidence: [
        `${best.length} 个主体形成接近表面链；存在 ${directions.length} 组不同方向的圆形端面轴。`,
        "父子顺序来自主体邻接路径；基座通过图端点、主体形态与首轴位置选择，不依赖世界坐标最低点，仍需确认。",
        ...(group.length > best.length
          ? ["邻接存在分支，未强行把所有主体放入运动链。"]
          : []),
      ],
    });
  }
  devices.push(
    ...matchGrippers(
      devices.filter((d) => d.kind === "articulated"),
      descriptors,
      usedAnchors,
      scale,
      gap,
    ),
  );
  devices.push(...matchPositioners(descriptors, usedAnchors, scale, gap));
  const staticSeeds = descriptors.filter(
    (d) =>
      !usedAnchors.has(d.id) &&
      d.diagonal > scale * 0.065 &&
      (d.planarCoverage > 0.93 || d.triangles < 32),
  );
  for (const group of components(staticSeeds, near * 2.5)) {
    group.forEach((d) => usedAnchors.add(d.id));
    devices.push({
      id: `static_${devices.length}`,
      kind: "static",
      name: "静态结构组候选",
      links: [{ anchor: group[0].id, meshIds: group.map((d) => d.id) }],
      evidence: [
        "大型平面主导部件与邻接板件按较宽距离阈值聚合；可能包含多个独立静态设备，需检查边界。",
        "仅表示本次按静态结构建模，不证明固定安装或不存在隐藏运动副。",
      ],
    });
  }
  // Assign small attachments against actual anchor surfaces. Device bounding-box
  // containment alone cannot distinguish a tool, a table and an arm.
  const ambiguousMeshes: string[] = [...suppressedCovers],
    unassigned: SurfaceDescriptor[] = [];
  for (const d of descriptors) {
    if (usedAnchors.has(d.id)) continue;
    if (suppressedCovers.has(d.id)) {
      unassigned.push(d);
      continue;
    }
    const scores = devices
      .flatMap((device) =>
        device.links.map((link) => {
          const anchors = link.meshIds
            .map((id) => byId.get(id))
            .filter((a) => usedAnchors.has(a.id));
          let distance = Infinity;
          for (const a of anchors) {
            if (boxGap(a.box, d.box) > near * 2) continue;
            distance = Math.min(distance, gap(a, d).distance);
          }
          return { device, link, distance };
        }),
      )
      .sort((a, b) => a.distance - b.distance);
    const best = scores[0],
      second = scores[1];
    if (!best || best.distance > near * 1.6) {
      unassigned.push(d);
      continue;
    }
    if (
      second &&
      Math.abs(second.distance - best.distance) < near * 0.12 &&
      second.link !== best.link
    ) {
      ambiguousMeshes.push(d.id);
      unassigned.push(d);
      continue;
    }
    best.link.meshIds.push(d.id);
  }
  if (unassigned.length)
    devices.push({
      id: `unknown_${devices.length}`,
      kind: "unknown",
      name: "未归属几何",
      links: [
        { anchor: unassigned[0].id, meshIds: unassigned.map((d) => d.id) },
      ],
      evidence: [
        "没有足够的受支持设备或运动副证据；保留几何，不强行归入机器人。",
        "此分组仅为未归属几何容器，固定显示不代表它们属于同一刚体或设备。",
      ],
    });
  const warnings = [
    "接近、端面圆形和共同空间分布只支持候选，不证明真实装配或关节。",
    "真实零位、限位、传动联动与隐藏关节仍需设备资料或多姿态验证。",
  ];
  if (descriptors.length === 1)
    warnings.unshift(
      "只有一个几何连通体；可能已焊接或布尔合并，不能可靠自动恢复全部连杆边界。",
    );
  if (ambiguousMeshes.length)
    warnings.push(
      `${ambiguousMeshes.length} 个部件存在竞争归属，请在按 link 着色下检查。`,
    );
  for (const kind of [
    "articulated",
    "positioner",
    "gripper",
    "static",
  ] as const) {
    const matches = devices.filter((d) => d.kind === kind);
    if (matches.length > 1) matches.forEach((d, i) => (d.name += ` ${i + 1}`));
  }
  progress("候选分析完成", 100);
  return {
    version: 1,
    sourceMeshCount,
    componentCount: descriptors.length,
    triangles: descriptors.reduce((s, d) => s + d.triangles, 0),
    tolerance: 1e-6,
    circleCount: descriptors.reduce((s, d) => s + d.circles.length, 0),
    ambiguousMeshes,
    devices,
    warnings,
    revision: crypto.randomUUID(),
    algorithmVersion: ANALYSIS_VERSION,
  };
}

export function applySceneAnalysis(
  project: Project,
  analysis: SceneAnalysis,
): void {
  const p: Project = {
    ...project,
    devices: [],
    links: [],
    meshes: project.meshes.map((m) => ({ ...m })),
    notes: [...project.notes],
  };
  const all = analysis.devices.flatMap((d) =>
      d.links.flatMap((l) => l.meshIds),
    ),
    expected = new Set(p.meshes.map((m) => m.id));
  if (
    all.length !== expected.size ||
    new Set(all).size !== all.length ||
    all.some((id) => !expected.has(id))
  )
    throw Error("候选几何覆盖与项目不一致，请重新分析");
  const meshes = new Map(p.meshes.map((m) => [m.id, m]));
  p.devices = [];
  p.links = [];
  if (
    analysis.devices.some(
      (d) =>
        !d.links.length ||
        d.links.some((l) => !l.virtual && !l.meshIds.includes(l.anchor)),
    )
  )
    throw Error("候选缺少有效主体");
  for (const proposal of analysis.devices) {
    const device = proposal.id,
      moving = proposal.links.filter((l) => l.joint?.axis).length;
    p.devices.push({
      id: device,
      name: proposal.name,
      template:
        proposal.template ||
        (proposal.kind === "articulated"
          ? moving === 6
            ? "6R"
            : "serial_candidate"
          : proposal.kind === "static"
            ? "static"
            : "unknown"),
    });
    proposal.links.forEach((link, i) => {
      const id = `${device}_link_${i}`,
        joint = link.joint,
        mesh = meshes.get(link.anchor);
      mesh.geometry.computeBoundingBox();
      const origin =
        joint?.origin ||
        mesh.geometry.boundingBox.getCenter(new T.Vector3()).toArray();
      p.links.push({
        id,
        name:
          proposal.kind === "articulated"
            ? i
              ? link.virtual
                ? `L${i} 法兰输出（几何待分离）`
                : `L${i} 第${i}运动连杆`
              : "L0 固定基座"
            : proposal.kind === "positioner"
              ? i
                ? proposal.links.length === 3 && i === 1
                  ? "倾转架候选"
                  : "回转台候选"
                : "底座 / 支架候选"
              : proposal.kind === "gripper"
                ? i
                  ? "指爪 / 部件候选"
                  : "夹爪本体候选"
                : "固定结构候选",
        device,
        parent: i
          ? `${device}_link_${link.parentIndex ?? i - 1}`
          : proposal.parentProposal
            ? `${proposal.parentProposal}_link_${proposal.parentLinkIndex}`
            : null,
        bind: bindAt(origin),
        confirmed: false,
        kinematicIndex: proposal.kind === "articulated" ? i : undefined,
        joint: joint?.axis
          ? {
              type: "revolute",
              axis: joint.axis,
              lower: -0.35,
              upper: 0.35,
              value: 0,
              limitSource: "demo_only",
              resolution: "candidate",
              source: [...proposal.evidence, ...joint.evidence].join("；"),
            }
          : {
              type: "fixed",
              resolution: i ? "unresolved" : "candidate",
              source: [...proposal.evidence, ...(joint?.evidence || [])].join(
                "；",
              ),
            },
      });
      link.meshIds.forEach((meshId) => (meshes.get(meshId).link = id));
    });
  }
  p.analysis = analysis;
  p.appliedAnalysisId = analysis.revision;
  p.notes.push(
    `几何分析：${analysis.sourceMeshCount} 个输入区域 → ${analysis.componentCount} 个连通分量；自动候选均未人工确认。`,
    ...analysis.warnings,
  );
  const errors = validate(p);
  if (errors.length) throw Error(errors.join("；"));
  Object.assign(project, p);
}
