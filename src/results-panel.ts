import type { Project } from "./types.ts";
import { ANALYSIS_VERSION } from "./scene-analysis.ts";

export interface ResultLink {
  id: string;
  name: string;
  meshIds: string[];
  joint: string;
  motion?: "R" | "P";
}
export interface ResultDevice {
  id: string;
  name: string;
  category: string;
  state: string;
  meshIds: string[];
  links: ResultLink[];
  pending: boolean;
  ambiguous: number;
}
const esc = (s: unknown) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function category(template: string) {
  if (template === "6R" || template === "serial_candidate") return "机器人";
  if (template === "2P-mimic") return "平行夹爪";
  if (template === "gripper_candidate") return "夹爪 · 内部运动待确认";
  if (template === "positioner_1R") return "单轴变位机";
  if (template === "positioner_2R") return "双轴变位机";
  if (template === "P") return "直线导轨";
  if (template === "static") return "静态结构";
  return "未分类 / 未归属";
}
export function resultDevices(p: Project): ResultDevice[] {
  const pending =
    !!p.analysis &&
    (p.analysis.revision
      ? p.appliedAnalysisId !== p.analysis.revision
      : p.analysis.devices.some(
          (d) => !p.devices.some((current) => current.id === d.id),
        ));
  if (pending)
    return p.analysis.devices.map((d) => ({
      id: d.id,
      name: d.name,
      category:
        d.kind === "articulated"
          ? "机器人候选"
          : d.kind === "positioner"
            ? "变位机候选"
            : d.kind === "gripper"
              ? "夹爪候选"
              : d.kind === "static"
                ? "静态结构候选"
                : "未归属几何",
      state: "候选 · 尚未应用",
      pending: true,
      meshIds: d.links.flatMap((l) => l.meshIds),
      links: d.links.map((l, i) => ({
        id: `${d.id}_link_${i}`,
        name:
          d.kind === "articulated"
            ? i
              ? `L${i} ${l.virtual ? "法兰输出坐标系（无独立网格）" : "运动连杆"}`
              : "L0 固定基座"
            : l.virtual
              ? "法兰输出坐标系（无独立网格）"
              : i
                ? `连杆 ${i} 候选`
                : "基座 / 参考体",
        meshIds: l.meshIds,
        joint: l.joint?.axis
          ? `${d.kind === "articulated" ? `J${i} · L${i - 1} → L${i} · ` : ""}R · ${l.joint.support === "two-sided" ? "双侧证据" : "单侧证据"}`
          : l.joint
            ? "运动副未知"
            : "参考体",
        motion: l.joint?.axis ? ("R" as const) : undefined,
      })),
      ambiguous: p.analysis.ambiguousMeshes.filter((id) =>
        d.links.some((l) => l.meshIds.includes(id)),
      ).length,
    }));
  return p.devices.map((d) => {
    const links = p.links.filter((l) => l.device === d.id),
      meshIds = p.meshes
        .filter((m) => links.some((l) => l.id === m.link))
        .map((m) => m.id);
    return {
      id: d.id,
      name: d.name,
      category: category(d.template),
      state:
        p.analysis && p.analysis.algorithmVersion !== ANALYSIS_VERSION
          ? "旧版结果 · 建议重新分析"
          : links.every((l) => l.confirmed)
            ? "已确认 / 示例已知"
            : "待确认",
      pending: false,
      meshIds,
      links: links.map((l) => ({
        id: l.id,
        name: l.name,
        meshIds: p.meshes.filter((m) => m.link === l.id).map((m) => m.id),
        motion:
          l.joint.type === "revolute"
            ? ("R" as const)
            : l.joint.type === "prismatic"
              ? ("P" as const)
              : undefined,
        joint:
          (l.kinematicIndex
            ? `J${l.kinematicIndex} · L${p.links.find((parent) => parent.id === l.parent)?.kinematicIndex ?? "?"} → L${l.kinematicIndex} · `
            : "") +
          (l.joint.resolution === "unresolved"
            ? "运动副未知"
            : l.joint.type === "fixed"
              ? "固定 / 参考体"
              : l.joint.type === "revolute"
                ? "R · 旋转"
                : "P · 移动"),
      })),
      ambiguous:
        p.analysis?.ambiguousMeshes.filter((id) => meshIds.includes(id))
          .length || 0,
    };
  });
}
export function resultsPanelHTML(
  entries: ResultDevice[],
  selected: Set<string>,
  open: Set<string>,
  resultVersion?: string,
): string {
  return `<div class="results-heading"><div><h3>识别结果</h3><small>${entries.some((d) => d.pending) ? "自动分析候选，等待应用" : "当前设备与部件归属"}</small><small class="analysis-version" data-current-version="${ANALYSIS_VERSION}" data-result-version="${esc(resultVersion || "none")}">算法 ${ANALYSIS_VERSION} · ${resultVersion ? `结果 ${esc(resultVersion)}` : "尚未分析"}</small></div><span>${entries.length} 项</span></div><div class="results-list">${
    entries
      .map((d, i) => {
        const count = d.meshIds.filter((id) => selected.has(id)).length;
        return `<article class="result-card ${count ? "has-selection" : ""}" data-result-card="${esc(d.id)}"><div class="result-card-top"><button class="result-device-select" data-result-device="${esc(d.id)}" aria-pressed="${count > 0}" aria-label="选择 ${esc(d.name)}"><span class="result-icon">${d.category.includes("机器人") ? "↻" : d.category.includes("夹爪") ? "⋈" : d.category.includes("导轨") ? "↔" : "◇"}</span><span><strong>${esc(d.name)}</strong><small>${esc(d.category)}</small></span></button><button class="result-focus" data-result-focus="${esc(d.id)}" title="选择并定位 ${esc(d.name)}" aria-label="定位 ${esc(d.name)}">⌖</button></div><div class="result-facts"><span>${d.meshIds.length} 几何</span><span>${d.links.length} link</span><span>${d.links.filter((l) => l.motion === "R").length} R / ${d.links.filter((l) => l.motion === "P").length} P</span></div><div class="result-status"><span>${esc(d.state)}</span>${count ? `<b>已选 ${count}/${d.meshIds.length}</b>` : d.ambiguous ? `<b>${d.ambiguous} 项归属待核验</b>` : ""}</div><details data-result-details="${esc(d.id)}" ${open.has(d.id) || (count > 0 && count < d.meshIds.length) ? "open" : ""}><summary>部件与连杆</summary>${d.links.map((l) => `<button data-result-link="${esc(l.id)}" class="result-link ${l.meshIds.some((id) => selected.has(id)) ? "selected" : ""}"><span>${esc(l.name)}<small>${esc(l.joint)}</small></span><b>${l.meshIds.length}</b></button>`).join("")}</details></article>`;
      })
      .join("") || '<p class="muted">导入场景后显示设备候选。</p>'
  }</div><div class="results-actions">${entries.some((d) => d.pending) ? '<button id="results-apply" class="primary">应用识别候选</button>' : ""}<button id="results-evidence">查看详细依据</button></div>`;
}
export function selectionDescription(
  p: Project,
  entries: ResultDevice[],
  selected: Set<string>,
): { title: string; detail: string } {
  if (!selected.size)
    return { title: "未选择对象", detail: "点击模型或识别结果卡片选择" };
  const device = entries.find(
    (d) =>
      d.meshIds.length === selected.size &&
      d.meshIds.every((id) => selected.has(id)),
  );
  if (device)
    return {
      title: device.name,
      detail: `${device.category} · ${selected.size} 个几何 · ${device.state}`,
    };
  for (const d of entries) {
    const l = d.links.find(
      (l) =>
        l.meshIds.length === selected.size &&
        l.meshIds.every((id) => selected.has(id)),
    );
    if (l)
      return {
        title: l.name,
        detail: `${d.name} · ${selected.size} 个几何 · ${l.joint}`,
      };
  }
  const meshes = p.meshes.filter((m) => selected.has(m.id)),
    links = new Set(meshes.map((m) => m.link));
  return {
    title:
      meshes.length === 1 ? meshes[0].name : `多选 ${meshes.length} 个几何`,
    detail: `${links.size} 个连杆归属 · 青色模型为当前选择`,
  };
}
