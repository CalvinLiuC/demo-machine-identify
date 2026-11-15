import type { SceneAnalysis } from "./scene-analysis.ts";
const esc = (s: unknown) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function recognitionHTML(a: SceneAnalysis): string {
  const joints = a.devices.flatMap((d) =>
    d.links.flatMap((l) => (l.joint ? [l.joint] : [])),
  );
  return `<section class="recognition-results"><h3>单体场景 · 自动机构分析</h3><div class="validation-grid"><div><small>连通分量</small><strong>${a.componentCount}</strong></div><div><small>局部圆形端面</small><strong>${a.circleCount}</strong></div><div><small>转轴候选</small><strong>${joints.filter((j) => j.axis).length}</strong></div><div><small>竞争归属</small><strong>${a.ambiguousMeshes.length}</strong></div></div><div class="notice">从 ${a.sourceMeshCount} 个输入区域自动拆分，不依赖文件名、设备型号或原始装配层级。所有结果仍是待确认候选，未获得真实机械限位和零位。应用将替换当前设备与关节结构，可撤销。</div><div class="report-actions"><button class="primary" id="apply-recognition">应用设备 / 连杆 / 关节候选</button> <button id="export-recognition">下载分析依据 JSON</button> ${a.ambiguousMeshes.length ? '<button id="inspect-ambiguous">选择竞争归属几何</button>' : ""}</div>${a.devices.map((d) => `<article class="recognition-device"><h3>${esc(d.name)} <span class="badge">${d.kind === "articulated" ? "串联机构" : d.kind === "static" ? "静态分组" : d.kind === "positioner" ? "变位机" : d.kind === "gripper" ? "夹爪" : "未归属容器"}</span></h3><p class="muted">${d.evidence.map(esc).join("<br>")}</p><table><thead><tr><th>候选 link</th><th>部件数</th><th>运动副依据</th><th>操作</th></tr></thead><tbody>${d.links.map((l, i) => `<tr><td>${i === 0 ? "基座 / 参考体" : `连杆 ${i}`}<small>${esc(l.anchor)}</small></td><td>${l.meshIds.length}</td><td>${l.joint ? (l.joint.axis ? `R 候选 · ${l.joint.support === "two-sided" ? "两侧同轴几何支持" : "单侧几何支持，较弱"}` : "运动副未知，暂固定显示") : "参考体，尚未确认固定安装"}${l.joint ? `<small>${l.joint.evidence.map(esc).join("<br>")}</small>` : ""}</td><td><button data-preview-group="${l.meshIds.map(esc).join(",")}" ${l.meshIds.length ? "" : "disabled"}>${l.meshIds.length ? "查看分组" : "坐标系 · 无网格"}</button></td></tr>`).join("")}</tbody></table></article>`).join("")}<h3>需要核验</h3><ul>${a.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>`;
}
