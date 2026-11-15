import * as T from "three";
import type { Project, Vec3 } from "./types.ts";

export const vec = (a: number[]) => new T.Vector3(a[0], a[1], a[2]);
export const matrix = (a: number[]) => new T.Matrix4().fromArray(a);
export const identity = () => new T.Matrix4().toArray();
export function bindAt(p: number[]) {
  return new T.Matrix4().makeTranslation(p[0], p[1], p[2]).toArray();
}
export function createProject(name = "未命名场景"): Project {
  return {
    version: 1,
    name,
    unit: "m",
    reference: "import_pose_as_model_zero",
    devices: [],
    links: [],
    meshes: [],
    notes: [],
  };
}
export function worldMatrices(p: Project, values: Record<string, number> = {}) {
  const out = new Map<string, T.Matrix4>(),
    visiting = new Set<string>();
  const walk = (id: string): T.Matrix4 => {
    if (out.has(id)) return out.get(id);
    if (visiting.has(id)) throw Error("运动链存在循环");
    visiting.add(id);
    const l = p.links.find((x) => x.id === id);
    if (!l) throw Error(`缺失 link: ${id}`);
    const b = matrix(l.bind),
      parent = l.parent ? p.links.find((x) => x.id === l.parent) : null;
    if (l.parent && !parent) throw Error("父 link 不存在");
    let result = parent
      ? walk(parent.id)
          .clone()
          .multiply(matrix(parent.bind).invert())
          .multiply(b)
      : b;
    const j = l.joint;
    if (j && j.type !== "fixed") {
      let q = values[l.id] ?? j.value ?? 0;
      if (j.mimic) {
        const m = p.links.find((x) => x.id === j.mimic);
        q =
          (values[m?.id] ?? m?.joint?.value ?? 0) * (j.multiplier ?? 1) +
          (j.offset ?? 0);
      }
      const axis = vec(j.axis).normalize();
      result = result
        .clone()
        .multiply(
          j.type === "revolute"
            ? new T.Matrix4().makeRotationAxis(axis, q)
            : new T.Matrix4().makeTranslation(
                ...axis.multiplyScalar(q).toArray(),
              ),
        );
    }
    visiting.delete(id);
    out.set(id, result);
    return result;
  };
  p.links.forEach((l) => walk(l.id));
  return out;
}
export function validate(p: Project) {
  const errors = [];
  for (const key of ["devices", "links", "meshes"] as const)
    if (new Set(p[key].map((x) => x.id)).size !== p[key].length)
      errors.push(`${key} ID 重复`);
  for (const item of [...p.devices, ...p.links])
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.id))
      errors.push("设备与 link ID 必须为安全的字母数字标识符");
  for (const l of p.links) {
    if (l.id === "world") errors.push("world 为整体场景保留 link 名称");
    if (!p.devices.some((d) => d.id === l.device))
      errors.push(`${l.id}: 设备不存在`);
    if (
      !Array.isArray(l.bind) ||
      l.bind.length !== 16 ||
      !l.bind.every(Number.isFinite)
    )
      errors.push(`${l.id}: 无效参考变换`);
    const j = l.joint;
    if (
      (!l.parent ||
        p.links.find((x) => x.id === l.parent)?.device !== l.device) &&
      j?.type !== "fixed"
    )
      errors.push(`${l.id}: 设备根与外部安装必须为固定连接`);
    if (j && !["fixed", "revolute", "prismatic"].includes(j.type))
      errors.push(`${l.id}: 不支持的关节类型`);
    if (j && j.type !== "fixed") {
      if (
        !Array.isArray(j.axis) ||
        j.axis.length !== 3 ||
        !j.axis.every(Number.isFinite) ||
        vec(j.axis).length() < 1e-8
      )
        errors.push(`${l.id}: 轴方向无效`);
      if (
        !Number.isFinite(j.value ?? 0) ||
        !Number.isFinite(j.multiplier ?? 1) ||
        !Number.isFinite(j.offset ?? 0)
      )
        errors.push(`${l.id}: 关节状态或联动参数无效`);
      if (
        !Number.isFinite(j.lower) ||
        !Number.isFinite(j.upper) ||
        j.lower >= j.upper
      )
        errors.push(`${l.id}: 演示范围无效`);
      if (j.mimic) {
        const target = p.links.find((x) => x.id === j.mimic);
        if (
          !target ||
          target.id === l.id ||
          target.device !== l.device ||
          target.joint?.mimic ||
          !target.joint ||
          target.joint.type !== j.type
        )
          errors.push(`${l.id}: 联动目标无效`);
      }
    }
  }
  for (const d of p.devices) {
    const roots = p.links.filter(
      (l) =>
        l.device === d.id &&
        (!l.parent || p.links.find((x) => x.id === l.parent)?.device !== d.id),
    );
    if (roots.length !== 1) errors.push(`${d.name}: 必须恰有一个设备根 link`);
  }
  for (const m of p.meshes)
    if (!p.links.some((l) => l.id === m.link))
      errors.push(`${m.id}: 尚未分配 link`);
  try {
    worldMatrices(p);
  } catch (e) {
    errors.push(e.message);
  }
  return [...new Set(errors)];
}
export function analyzeGeometry(p: Project) {
  return p.meshes.map((m) => {
    const pos = m.geometry.getAttribute("position");
    m.geometry.computeBoundingBox();
    const size = m.geometry.boundingBox.getSize(new T.Vector3()).toArray(),
      sorted = [...size].sort((a, b) => b - a);
    const elongated = sorted[0] / Math.max(sorted[1], 1e-8) > 5;
    return {
      mesh: m.id,
      name: m.name,
      triangles: m.geometry.index ? m.geometry.index.count / 3 : pos.count / 3,
      size,
      category: elongated ? "长条结构：导轨 / 梁 / 连杆候选" : "未分类刚体候选",
      basis: elongated
        ? "包围盒长宽比 > 5；不能据此确认导轨或运动副"
        : "单姿态几何不足以确定设备类别",
      status: "待确认",
    };
  });
}
