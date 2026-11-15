import "./style.css";
import * as T from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { Viewer } from "./viewer.ts";
import { demo } from "./demo.ts";
import { importGLB, splitConnected } from "./import.ts";
import {
  analyzeGeometry,
  bindAt,
  matrix,
  validate,
  worldMatrices,
} from "./model.ts";
import {
  assemblyData,
  exportBundle,
  projectData,
  reconstructionError,
  restoreProject,
  urdf,
} from "./export.ts";
import type { Project, Vec3, JointType } from "./types.ts";
import { axisCandidates } from "./geometry.ts";
import { templateChecks } from "./templates.ts";
import { railProposals } from "./rail-template.ts";

const $ = <E extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as E;
const esc = (s: unknown) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
let project: Project = demo(),
  selected = new Set<string>(),
  active = "axis_2",
  tab = "structure",
  colorMode = "device",
  axes = true,
  playing = false,
  playTime = 0;
let report: ReturnType<typeof analyzeGeometry> | null = null;
let history: string[] = [];
const app = $("app");
app.innerHTML = `
<header><div class="brand"><span class="brand-mark">K<span>↗</span></span><div><strong>KINEMATIC <b>LAB</b></strong><small>工业场景 · 运动学重建工作台</small></div></div><div class="header-status"><i></i> 本地处理 <span>/</span> DEMO 0.1</div><div class="header-actions"><button id="sample">载入示例</button><button id="open-project">打开项目</button><button id="save">保存项目</button><button id="export" class="primary">↗ 导出装配包</button></div></header>
<section class="workflow"><span class="step done">01 <b>导入场景</b></span><em>—</em><span class="step done">02 <b>设备与连杆</b></span><em>—</em><span class="step current">03 <b>关节与装配</b></span><em>—</em><span class="step">04 <b>验证与导出</b></span><span class="workflow-note">仅运动学 · 不包含动力学参数</span></section>
<main><aside class="left"><div class="panel-heading"><h2>场景资源</h2><span id="mesh-count"></span></div><button id="import" class="import-button"><span>＋</span><strong>导入 GLB 场景</strong><small>文件仅在浏览器本地处理</small></button><div class="import-options"><label>尺度<select id="scale"><option value="1">米 · ×1</option><option value="0.001">毫米 · ×0.001</option><option value="0.01">厘米 · ×0.01</option></select></label><label>源上方向<select id="up"><option value="y">Y-up / glTF</option><option value="z">Z-up</option></select></label></div><div class="tabs"><button id="structure-tab" class="active">装配结构</button><button id="geometry-tab">几何列表</button></div><div id="tree" class="tree"></div><div class="left-bottom"><div class="legend"><i class="amber"></i>旋转关节 <i class="cyan"></i>移动关节</div><button id="analyze">◇ 几何候选分析</button><button id="new-device">＋ 从选择建立设备</button><button id="new-link">＋ 从选择建立连杆</button><button id="split">分离选中网格的连通分量</button><p>点击选择 · Ctrl / Shift 多选<br>几何分组 ≠ 已确认的机械结构</p></div></aside>
<section class="center"><div class="viewport-header"><div><span class="live-dot"></span><strong id="scene-title"></strong><small id="scene-meta"></small></div><div class="view-buttons"><select id="colors"><option value="device">按设备着色</option><option value="link">按连杆着色</option><option value="original">原始颜色</option></select><button id="fit" title="适配场景">⌖ 适配</button><button id="axes" class="active">轴线</button><button id="wire">线框</button></div></div><div id="viewport"><div class="viewport-tag">PERSPECTIVE <span> / Z-UP / METERS</span></div><div class="axis-legend"><b class="x">X</b><b class="y">Y</b><b class="z">Z</b><span>左键旋转 · 右键平移 · 滚轮缩放</span></div><div id="selection-hint"></div></div><section class="motion"><div class="motion-heading"><div><span class="eyebrow">KINEMATIC PREVIEW</span><h2>关节运动预览 <small id="dof-count"></small></h2></div><div><button id="play">▷ 自动演示</button><button id="reset">↺ 参考姿态</button><button id="verify">✓ 验证模型</button></div></div><div id="sliders" class="sliders"></div><p class="motion-note">所有滑块范围均为演示范围；参考零位为导入姿态，不代表厂商零位。联动关节由源关节驱动。</p></section></section>
<aside class="right"><div class="panel-heading"><h2>参数与证据</h2><span class="tag">INSPECTOR</span></div><div id="inspector"></div></aside></main>
<footer><span id="status">已载入已知机构示例。可以逐轴预览，或导入自己的 GLB。</span><span id="summary"></span></footer><div id="toast" role="status"></div>
<input id="glb-file" type="file" accept=".glb" hidden><input id="project-file" type="file" accept=".json" hidden>
<dialog id="report"><div class="dialog-heading"><h2 id="report-title"></h2><button id="close-report">关闭 ✕</button></div><div id="report-content"></div></dialog>`;
let viewer: Viewer;
try {
  viewer = new Viewer($("viewport"), (id, multi) => {
    if (!multi) selected.clear();
    selected.has(id) ? selected.delete(id) : selected.add(id);
    active = project.meshes.find((m) => m.id === id)?.link || active;
    render();
  });
} catch (e) {
  $("viewport").innerHTML =
    `<div class="webgl-error">无法初始化 WebGL。请使用支持 WebGL 的浏览器。<br>${esc((e as Error).message)}</div>`;
  throw e;
}
function notify(message: string) {
  $("status").textContent = message;
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  setTimeout(() => $("toast").classList.remove("visible"), 4000);
}
function checkpoint() {
  history.push(JSON.stringify(projectData(project)));
  if (history.length > 12) history.shift();
}
function load(p: Project) {
  playing = false;
  $("play").textContent = "▷ 自动演示";
  project.meshes.forEach((m) => m.geometry.dispose());
  project = p;
  selected.clear();
  active = project.links[0]?.id;
  report = null;
  viewer.load(project);
  render();
}
function refresh() {
  viewer.update(project, selected, colorMode, axes);
}
function render() {
  $("scene-title").textContent = project.name;
  $("scene-meta").textContent =
    `${project.devices.length} 个设备 / ${project.links.length} 个连杆`;
  $("mesh-count").textContent = `${project.meshes.length} MESH`;
  $("selection-hint").textContent = selected.size
    ? `已选择 ${selected.size} 个几何 · 可分配到连杆`
    : "选择几何以检查归属";
  $("summary").textContent =
    `${project.links.filter((l) => l.confirmed).length}/${project.links.length} link 已确认 · m · Z↑`;
  renderTree();
  renderInspector();
  renderSliders();
  refresh();
}
function renderTree() {
  $("structure-tab").classList.toggle("active", tab === "structure");
  $("geometry-tab").classList.toggle("active", tab === "geometry");
  if (tab === "geometry") {
    $("tree").innerHTML = project.meshes
      .map(
        (m) =>
          `<button class="mesh-row ${selected.has(m.id) ? "selected" : ""}" data-mesh="${esc(m.id)}"><span>◇</span><div>${esc(m.name)}<small>${esc(m.link)}</small></div></button>`,
      )
      .join("");
    document.querySelectorAll<HTMLButtonElement>("[data-mesh]").forEach(
      (b) =>
        (b.onclick = (e) => {
          if (!(e.ctrlKey || e.shiftKey)) selected.clear();
          const id = b.dataset.mesh;
          selected.has(id) ? selected.delete(id) : selected.add(id);
          active = project.meshes.find((m) => m.id === id)?.link || active;
          render();
        }),
    );
    return;
  }
  const node = (id: string, depth = 0): string => {
    if (depth > project.links.length) return "";
    const l = project.links.find((l) => l.id === id);
    if (!l) return "";
    const n = project.meshes.filter((m) => m.link === id).length;
    return (
      `<button data-link="${esc(id)}" class="link-row ${active === id ? "selected" : ""}" style="padding-left:${12 + depth * 13}px"><span class="joint-icon ${l.joint.type}">${l.joint.type === "fixed" ? "▪" : l.joint.type === "prismatic" ? "↔" : "↻"}</span><span class="link-name">${esc(l.name)}</span><small>${n || "–"}</small><i class="confirm-dot ${l.confirmed ? "confirmed" : ""}" title="${l.confirmed ? "已确认" : "待确认"}"></i></button>` +
      project.links
        .filter((x) => x.parent === id && x.device === l.device)
        .map((x) => node(x.id, depth + 1))
        .join("")
    );
  };
  $("tree").innerHTML = project.devices
    .map((d, i) => {
      const roots = project.links.filter(
        (l) =>
          l.device === d.id &&
          (!l.parent ||
            project.links.find((x) => x.id === l.parent)?.device !== d.id),
      );
      return `<div class="device-heading"><span class="device-index">0${i + 1}</span><strong>${esc(d.name)}</strong><span class="tag">${esc(d.template)}</span></div>${roots.map((l) => node(l.id)).join("")}`;
    })
    .join("");
  document.querySelectorAll<HTMLButtonElement>("[data-link]").forEach(
    (b) =>
      (b.onclick = () => {
        active = b.dataset.link;
        selected = new Set(
          project.meshes.filter((m) => m.link === active).map((m) => m.id),
        );
        render();
      }),
  );
}
function renderInspector() {
  const l = project.links.find((l) => l.id === active);
  if (!l) {
    $("inspector").innerHTML = '<p class="muted">选择一个连杆开始编辑</p>';
    return;
  }
  const position = new T.Vector3().setFromMatrixPosition(matrix(l.bind)),
    j = l.joint;
  const opts = project.links
    .filter((x) => x.id !== l.id)
    .map(
      (x) =>
        `<option value="${esc(x.id)}" ${l.parent === x.id ? "selected" : ""}>${esc(project.devices.find((d) => d.id === x.device)?.name)} / ${esc(x.name)}</option>`,
    )
    .join("");
  const triplet = (name: string, values: number[]) =>
    `<div class="vector-input">${values.map((v, i) => `<label>${["X", "Y", "Z"][i]}<input type="number" step="0.01" name="${name}${i}" value="${Number(v.toFixed(6))}" required></label>`).join("")}</div>`;
  $("inspector").innerHTML =
    `<div class="inspector-title"><span class="eyebrow">RIGID LINK</span><h3>${esc(l.name)}</h3><span class="badge ${l.confirmed ? "ok" : ""}">${l.confirmed ? "已人工确认 / 示例已知" : "待确认"}</span></div><form id="joint-form"><label class="field">连杆名称<input name="name" value="${esc(l.name)}" required></label><label class="field">所属设备<select name="device">${project.devices.map((d) => `<option value="${esc(d.id)}" ${d.id === l.device ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label><label class="field">父连杆 / 安装宿主<select name="parent"><option value="">世界坐标系 / 无父连杆</option>${opts}</select></label><label class="field">关节类型<select name="type">${[
      ["fixed", "固定 Fixed"],
      ["revolute", "旋转 Revolute"],
      ["prismatic", "移动 Prismatic"],
    ]
      .map(
        ([v, n]) =>
          `<option value="${v}" ${j.type === v ? "selected" : ""}>${n}</option>`,
      )
      .join(
        "",
      )}</select></label><div class="field">参考关节原点 <small>场景坐标 · 米</small>${triplet("origin", position.toArray())}</div><div class="field">关节轴方向 <small>参考坐标系</small>${triplet("axis", j.axis || [0, 0, 1])}</div><div class="field">演示范围 <small>旋转 rad / 移动 m</small><div class="range-input"><input name="lower" type="number" step="0.01" value="${j.lower ?? -1}"><span>→</span><input name="upper" type="number" step="0.01" value="${j.upper ?? 1}"></div></div><label class="field">线性联动源<select name="mimic"><option value="">独立关节</option>${project.links
      .filter(
        (x) =>
          x.id !== l.id &&
          x.device === l.device &&
          x.joint.type === j.type &&
          j.type !== "fixed" &&
          !x.joint.mimic,
      )
      .map(
        (x) =>
          `<option value="${esc(x.id)}" ${j.mimic === x.id ? "selected" : ""}>${esc(x.name)}</option>`,
      )
      .join(
        "",
      )}</select></label><div class="range-input"><label class="field">倍数<input name="multiplier" type="number" step="0.1" value="${j.multiplier ?? 1}"></label><label class="field">偏置<input name="offset" type="number" step="0.01" value="${j.offset ?? 0}"></label></div><label class="check"><input type="checkbox" name="confirmed" ${l.confirmed ? "checked" : ""}> 我已确认分组、运动副与安装关系</label><button type="submit" class="primary full">应用参数</button></form><button id="assign" class="full secondary" ${selected.size ? "" : "disabled"}>将选中 ${selected.size} 个几何分配到此 link</button><button id="center-origin" class="full secondary" ${selected.size ? "" : "disabled"}>原点移至选中几何包围盒中心</button><button id="fit-axis" class="full secondary">拟合选中几何的轴线候选</button><div class="evidence"><h4>◇ 参数依据</h4><p>${esc(j.source || "尚无运动学证据；需要人工确认。")}</p><dl><dt>参考零位</dt><dd>导入姿态 / 建模定义</dd><dt>运动限位</dt><dd class="warning">未知 · 当前为演示范围</dd><dt>几何归属</dt><dd>${project.meshes.filter((m) => m.link === l.id).length} 个网格</dd><dt>安装关系</dt><dd>${l.parent && project.links.find((x) => x.id === l.parent)?.device !== l.device ? "跨设备固定安装候选" : "设备内部 / 世界"}</dd></dl></div><div class="inspector-footer"><button id="undo" ${history.length ? "" : "disabled"}>↶ 撤销</button><button id="urdf-preview">查看 URDF</button></div>`;
  $("joint-form").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const n = (k: string) => Number(fd.get(k)),
      str = (k: string) => String(fd.get(k) || "");
    const before = JSON.stringify(projectData(project));
    l.name = str("name");
    l.device = str("device");
    l.parent = str("parent") || null;
    l.confirmed = fd.has("confirmed");
    const rot = new T.Matrix4().extractRotation(matrix(l.bind));
    rot.setPosition(n("origin0"), n("origin1"), n("origin2"));
    l.bind = rot.toArray();
    l.joint = {
      type: str("type") as JointType,
      axis: [n("axis0"), n("axis1"), n("axis2")],
      lower: n("lower"),
      upper: n("upper"),
      value: 0,
      source: "人工编辑；未提供厂商资料",
      limitSource: "demo_only",
      mimic: str("mimic") || undefined,
      multiplier: n("multiplier"),
      offset: n("offset"),
    };
    const errors = validate(project);
    const external =
      l.parent &&
      project.links.find((x) => x.id === l.parent)?.device !== l.device;
    if (external && l.joint.type !== "fixed")
      errors.push("设备间安装必须为固定连接；可运动副请建在设备内部");
    if (errors.length) {
      load(restoreProject(JSON.parse(before)));
      notify(`未应用：${errors.join("；")}`);
      return;
    }
    history.push(before);
    stopPlay();
    render();
    notify("已应用参数；导入参考姿态保持不变。");
  };
  $("assign").onclick = () => {
    checkpoint();
    project.meshes
      .filter((m) => selected.has(m.id))
      .forEach((m) => (m.link = l.id));
    render();
    notify("已更新几何归属。");
  };
  $("center-origin").onclick = () => {
    checkpoint();
    const box = selectionBox(),
      c = box.getCenter(new T.Vector3());
    const b = matrix(l.bind);
    b.setPosition(c);
    l.bind = b.toArray();
    render();
    notify("已设置几何中心为参考原点；这不代表已识别真实关节中心。");
  };
  $("fit-axis").onclick = () => {
    if (!selected.size) {
      notify("请先选择圆柱形或长条形几何。");
      return;
    }
    const candidates = project.meshes
      .filter((m) => selected.has(m.id))
      .flatMap(axisCandidates);
    showReport(
      "几何轴线候选",
      `<div class="notice">仅对完整网格进行 PCA / 圆柱拟合。外壳圆柱不必然是关节，正方向和真实零位仍需确认。候选点与方向使用规范化场景坐标。</div><table><thead><tr><th>几何 / 方法</th><th>依据</th><th></th></tr></thead><tbody>${candidates.map((c, i) => `<tr><td>${esc(project.meshes.find((m) => m.id === c.mesh)?.name)}<small>${c.kind === "cylinder" ? "圆柱拟合" : "PCA 主轴"}</small></td><td>${esc(c.evidence)}<small>轴向 ${c.direction.map((n) => n.toFixed(3)).join(", ")}</small></td><td><button data-candidate="${i}">应用候选</button></td></tr>`).join("")}</tbody></table>`,
    );
    document.querySelectorAll<HTMLButtonElement>("[data-candidate]").forEach(
      (b) =>
        (b.onclick = () => {
          const c = candidates[Number(b.dataset.candidate)];
          checkpoint();
          const bind = matrix(l.bind),
            rotation = new T.Matrix4().extractRotation(bind).invert();
          l.joint.axis = new T.Vector3(...c.direction)
            .transformDirection(rotation)
            .toArray();
          bind.setPosition(...c.point);
          l.bind = bind.toArray();
          l.joint.source = c.evidence;
          l.confirmed = false;
          ($("report") as HTMLDialogElement).close();
          render();
          notify("已应用几何候选；请检查轴向、关节类型与真实运动。");
        }),
    );
  };
  $("undo").onclick = () => {
    const old = history.pop();
    if (old) load(restoreProject(JSON.parse(old)));
  };
  $("urdf-preview").onclick = () =>
    showReport(
      "设备 URDF 预览",
      `<p class="muted">仅运动学。限位与 effort / velocity 为演示兼容参数。</p><pre>${esc(urdf(project, l.device))}</pre>`,
    );
}
function renderSliders() {
  const links = project.links.filter((l) => l.joint.type !== "fixed");
  $("dof-count").textContent =
    `${links.filter((l) => !l.joint.mimic).length} 独立自由度`;
  $("sliders").innerHTML =
    links
      .map((l) => {
        const j = l.joint,
          q = j.value || 0,
          rotation = j.type === "revolute";
        return `<div class="slider-card ${j.mimic ? "mimic" : ""}"><div><span class="joint-icon ${j.type}">${rotation ? "↻" : "↔"}</span><strong>${esc(l.name)}</strong><output id="value-${l.id}">${rotation ? ((q * 180) / Math.PI).toFixed(1) + "°" : (q * 1000).toFixed(1) + " mm"}</output></div><input aria-label="${esc(l.name)}" data-slider="${esc(l.id)}" type="range" min="${j.lower}" max="${j.upper}" step="${rotation ? 0.005 : 0.0005}" value="${q}" ${j.mimic ? "disabled" : ""}><small>${j.mimic ? "联动 ← " + esc(j.mimic) : "DEMO RANGE · " + (rotation ? "R" : "P")}</small></div>`;
      })
      .join("") ||
    '<p class="muted">还没有运动关节。选择连杆，在右侧定义关节。</p>';
  document.querySelectorAll<HTMLInputElement>("[data-slider]").forEach(
    (input) =>
      (input.oninput = () => {
        stopPlay();
        const l = project.links.find((l) => l.id === input.dataset.slider);
        l.joint.value = Number(input.value);
        updateMimic();
        updateOutputs();
        refresh();
      }),
  );
}
function updateMimic() {
  for (const l of project.links) {
    const j = l.joint;
    if (j.mimic) {
      const source = project.links.find((x) => x.id === j.mimic);
      j.value =
        (source?.joint.value || 0) * (j.multiplier ?? 1) + (j.offset ?? 0);
    }
  }
}
function updateOutputs() {
  for (const l of project.links) {
    const o = $(`value-${l.id}`);
    if (!o) continue;
    const q = l.joint.value || 0;
    o.textContent =
      l.joint.type === "revolute"
        ? `${((q * 180) / Math.PI).toFixed(1)}°`
        : `${(q * 1000).toFixed(1)} mm`;
    const slider = document.querySelector<HTMLInputElement>(
      `[data-slider="${l.id}"]`,
    );
    if (slider) slider.value = String(q);
  }
}
function stopPlay() {
  playing = false;
  $("play").textContent = "▷ 自动演示";
}
function selectionBox() {
  const box = new T.Box3();
  project.meshes
    .filter((m) => selected.has(m.id))
    .forEach((m) => {
      m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox);
    });
  return box;
}
function showReport(title: string, html: string) {
  $("report-title").textContent = title;
  $("report-content").innerHTML = html;
  ($("report") as HTMLDialogElement).showModal();
}
function download(
  name: string,
  data: BlobPart,
  type = "application/octet-stream",
) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("sample").onclick = () => {
  checkpoint();
  load(demo());
  notify("已载入已知模板示例。示例结构来自预定义模板，不是自动识别。");
};
$("structure-tab").onclick = () => {
  tab = "structure";
  renderTree();
};
$("geometry-tab").onclick = () => {
  tab = "geometry";
  renderTree();
};
$("fit").onclick = () => viewer.fit();
$("axes").onclick = () => {
  axes = !axes;
  $("axes").classList.toggle("active", axes);
  refresh();
};
$("wire").onclick = () => {
  viewer.wireframe = !viewer.wireframe;
  $("wire").classList.toggle("active", viewer.wireframe);
  refresh();
};
$("colors").onchange = (e) => {
  colorMode = (e.target as HTMLSelectElement).value;
  refresh();
};
$("import").onclick = () => ($("glb-file") as HTMLInputElement).click();
$("glb-file").onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  notify("正在读取本地 GLB…");
  try {
    const p = await importGLB(
      file,
      Number(($("scale") as HTMLSelectElement).value),
      ($("up") as HTMLSelectElement).value,
    );
    checkpoint();
    load(p);
    tab = "geometry";
    render();
    notify(
      `已导入 ${p.meshes.length} 个几何区域。请分析候选并确认设备与连杆。`,
    );
  } catch (err) {
    notify(`导入失败：${(err as Error).message}`);
  } finally {
    input.value = "";
  }
};
$("save").onclick = () =>
  download(
    "kinematic-project.json",
    JSON.stringify(projectData(project)),
    "application/json",
  );
$("open-project").onclick = () =>
  ($("project-file") as HTMLInputElement).click();
$("project-file").onchange = async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  try {
    const p = restoreProject(JSON.parse(await file.text()));
    checkpoint();
    load(p);
    notify("项目已恢复。");
  } catch (err) {
    notify(`打开失败：${(err as Error).message}`);
  } finally {
    input.value = "";
  }
};
$("export").onclick = () => {
  try {
    const files = exportBundle(project);
    download("kinematic-assembly.zip", files as BlobPart);
    notify("已导出独立设备 URDF、整体 URDF、局部 STL、装配关系和可重开项目。");
  } catch (e) {
    notify(`导出失败：${(e as Error).message}`);
  }
};
$("reset").onclick = () => {
  stopPlay();
  project.links.forEach((l) => (l.joint.value = 0));
  updateMimic();
  updateOutputs();
  refresh();
  notify("已恢复导入参考姿态。");
};
$("play").onclick = () => {
  playing = !playing;
  playTime = performance.now();
  $("play").textContent = playing ? "Ⅱ 停止演示" : "▷ 自动演示";
};
viewer.tick = () => {
  if (!playing) return;
  const t = (performance.now() - playTime) / 1000;
  project.links
    .filter((l) => l.joint.type !== "fixed" && !l.joint.mimic)
    .forEach((l, i) => {
      const j = l.joint,
        mid = (j.lower + j.upper) / 2,
        amp = (j.upper - j.lower) * 0.22;
      j.value = mid + Math.sin(t * 0.6 + i * 0.7) * amp;
    });
  updateMimic();
  updateOutputs();
  refresh();
};
$("new-device").onclick = () => {
  if (!selected.size) {
    notify("请先在视图或几何列表中选择设备几何。");
    return;
  }
  showReport(
    "从选择建立设备",
    `<form id="device-form" class="create-form"><label class="field">设备名称<input name="name" value="新设备" required></label><label class="field">构型模板<select name="template"><option value="unknown">未知 / 手工建模</option><option value="P">直线导轨 · P</option><option value="6R">六轴机器人 · 6R</option><option value="2P-mimic">平行夹爪 · 双 P 联动</option><option value="static">静态工具 / 底座</option></select></label><p class="muted">模板只声明预期构型，不自动猜测被遮挡的关节。创建后请逐个分配运动连杆和轴线。</p><button class="primary">建立设备</button></form>`,
  );
  $("device-form").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    checkpoint();
    const id = uid("device"),
      root = uid("root");
    project.devices.push({
      id,
      name: String(fd.get("name")),
      template: String(fd.get("template")),
    });
    project.links.push({
      id: root,
      name: "base",
      device: id,
      parent: null,
      bind: bindAt(selectionBox().getCenter(new T.Vector3()).toArray()),
      joint: { type: "fixed", source: "人工选择设备边界" },
      confirmed: false,
    });
    project.meshes
      .filter((m) => selected.has(m.id))
      .forEach((m) => (m.link = root));
    active = root;
    ($("report") as HTMLDialogElement).close();
    tab = "structure";
    render();
    notify("已建立独立设备。请按真实刚体分组添加连杆。");
  };
};
$("new-link").onclick = () => {
  if (!selected.size) {
    notify("请先选择属于同一刚体的几何。");
    return;
  }
  const parent = project.links.find((l) => l.id === active);
  if (!parent) return;
  showReport(
    "从选择建立运动连杆",
    `<form id="link-form" class="create-form"><p class="muted">父连杆：${esc(parent.name)}。以选择包围盒中心为暂定原点，默认轴向 Z，需要人工调整。</p><label class="field">连杆名称<input name="name" value="link_${project.links.length}" required></label><label class="field">关节类型<select name="type"><option value="revolute">旋转 R</option><option value="prismatic">移动 P</option><option value="fixed">固定</option></select></label><button class="primary">建立连杆</button></form>`,
  );
  $("link-form").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    checkpoint();
    const id = uid("link"),
      type = String(fd.get("type")) as JointType;
    project.links.push({
      id,
      name: String(fd.get("name")),
      device: parent.device,
      parent: parent.id,
      bind: bindAt(selectionBox().getCenter(new T.Vector3()).toArray()),
      joint: {
        type,
        axis: [0, 0, 1],
        value: 0,
        lower: type === "prismatic" ? -0.2 : -Math.PI,
        upper: type === "prismatic" ? 0.2 : Math.PI,
        limitSource: "demo_only",
        source: "人工分组；包围盒中心和 Z 轴为待确认占位",
      },
      confirmed: false,
    });
    project.meshes
      .filter((m) => selected.has(m.id))
      .forEach((m) => (m.link = id));
    active = id;
    ($("report") as HTMLDialogElement).close();
    render();
    notify("已建立连杆。请确认关节原点、轴向和父子关系。");
  };
};
$("split").onclick = () => {
  if (!selected.size) {
    notify("请先选择网格。");
    return;
  }
  try {
    checkpoint();
    const result = [];
    let count = 0;
    for (const m of project.meshes) {
      if (!selected.has(m.id)) {
        result.push(m);
        continue;
      }
      const parts = splitConnected(m);
      count += parts.length;
      result.push(...parts);
    }
    if (result.length > 4000) {
      notify("分量超过 4000，已取消。请使用保留合理部件划分的模型。");
      return;
    }
    const old = project.meshes;
    project.meshes = result;
    old.filter((m) => selected.has(m.id)).forEach((m) => m.geometry.dispose());
    selected.clear();
    viewer.load(project);
    render();
    notify(
      `选中几何已分离成 ${count} 个连通分量；不代表 ${count} 个机械零件。`,
    );
  } catch (e) {
    notify((e as Error).message);
  }
};
$("analyze").onclick = () => {
  report = analyzeGeometry(project);
  const proposals = railProposals(project).filter((c) => {
    const meshes = project.meshes.filter((m) =>
      [...c.fixedMeshes, c.carriageMesh].includes(m.id),
    );
    const links = meshes.map((m) => project.links.find((l) => l.id === m.link));
    return links.every(
      (l) =>
        l?.id === links[0]?.id &&
        !l.confirmed &&
        project.devices.find((d) => d.id === l.device)?.template === "unknown",
    );
  });
  showReport(
    "几何候选分析",
    `<div class="notice">本版使用确定性包围盒与长宽比分析，只生成几何候选，不推断真实关节或安装关系。内置示例使用已知模板。</div><div class="report-actions"><button id="download-glb">下载无运动学 GLB 测试样本</button></div><table><thead><tr><th>几何</th><th>尺寸 / m</th><th>候选与依据</th></tr></thead><tbody>${report.map((r) => `<tr><td>${esc(r.name)}<small>${r.triangles.toFixed(0)} triangles</small></td><td>${r.size.map((n) => n.toFixed(3)).join(" × ")}</td><td><strong>${esc(r.category)}</strong><small>${esc(r.basis)}</small><span class="badge">${r.status}</span></td></tr>`).join("")}</tbody></table>`,
  );
  $("report-content").insertAdjacentHTML(
    "afterbegin",
    `<h3>直线导轨模板匹配</h3><p class="muted">当前仅支持 Z-up 场景中沿 X/Y 的双轮廓导轨与单网格滑台；只对未分类、未确认几何提供分组建议。</p>${proposals.length ? proposals.map((c, i) => `<div class="notice"><strong>候选 ${i + 1}：固定体 ${c.fixedMeshes.length} 个网格 + 1 个滑台</strong><ul>${c.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul><button data-rail="${i}">确认分组并建立 P 运动副候选</button></div>`).join("") : '<p class="muted">没有满足此模板全部条件的未分类候选。可继续人工分组，不强行匹配。</p>'}`,
  );
  document.querySelectorAll<HTMLButtonElement>("[data-rail]").forEach(
    (b) =>
      (b.onclick = () => {
        const c = proposals[Number(b.dataset.rail)];
        checkpoint();
        const device = uid("rail"),
          base = uid("rail_base"),
          carriage = uid("carriage");
        project.devices.push({ id: device, name: "导轨候选", template: "P" });
        project.links.push({
          id: base,
          name: "轨道固定体",
          device,
          parent: null,
          bind: bindAt(c.baseOrigin),
          confirmed: false,
          joint: { type: "fixed", source: c.evidence.join("；") },
        });
        project.links.push({
          id: carriage,
          name: "移动滑台",
          device,
          parent: base,
          bind: bindAt(c.origin),
          confirmed: false,
          joint: {
            type: "prismatic",
            axis: c.axis,
            value: 0,
            lower: -0.2,
            upper: 0.2,
            limitSource: "demo_only",
            source: "双轮廓导轨模板推断 P 关节；需要人工或多姿态确认",
          },
        });
        project.meshes.forEach((m) => {
          if (c.fixedMeshes.includes(m.id)) m.link = base;
          if (m.id === c.carriageMesh) m.link = carriage;
        });
        active = carriage;
        selected = new Set([c.carriageMesh]);
        tab = "structure";
        ($("report") as HTMLDialogElement).close();
        render();
        notify("已建立导轨候选；方向、运动副、行程和外部安装仍需确认。");
      }),
  );
  $("download-glb").onclick = async () => {
    try {
      const group = new T.Group();
      for (const m of project.meshes) {
        const mesh = new T.Mesh(
          m.geometry,
          new T.MeshStandardMaterial({ color: m.color }),
        );
        mesh.name = `geometry_${group.children.length}`;
        group.add(mesh);
      }
      group.rotation.x = -Math.PI / 2;
      const data = await new GLTFExporter().parseAsync(group, { binary: true });
      download("static-scene.glb", data as ArrayBuffer);
      group.children.forEach((o: T.Mesh) =>
        (o.material as T.Material).dispose(),
      );
      notify("已下载静态样本：无设备语义、关节或装配标注。");
    } catch (e) {
      notify(`样本导出失败：${(e as Error).message}`);
    }
  };
};
$("verify").onclick = () => {
  const errors = validate(project),
    unconfirmed = project.links.filter((l) => !l.confirmed),
    error = reconstructionError(project),
    worlds = worldMatrices(project),
    assembly = assemblyData(project);
  const interfaces = project.links.filter(
    (l) =>
      l.parent &&
      project.links.find((x) => x.id === l.parent)?.device !== l.device,
  );
  let drift = 0;
  for (const l of interfaces) {
    const parent = project.links.find((x) => x.id === l.parent),
      expected = worlds
        .get(parent.id)
        .clone()
        .multiply(matrix(parent.bind).invert())
        .multiply(matrix(l.bind));
    const actual = worlds.get(l.id);
    drift = Math.max(
      drift,
      new T.Vector3()
        .setFromMatrixPosition(expected)
        .distanceTo(new T.Vector3().setFromMatrixPosition(actual)),
    );
  }
  showReport(
    "运动学验证报告",
    `<div class="validation-grid"><div><small>结构检查</small><strong class="${errors.length ? "warning" : "success"}">${errors.length ? errors.length + " 项错误" : "通过"}</strong></div><div><small>参考姿态最大顶点误差</small><strong>${error.toExponential(2)} m</strong></div><div><small>当前安装点漂移</small><strong>${drift.toExponential(2)} m</strong></div><div><small>待确认连杆</small><strong>${unconfirmed.length}</strong></div></div>${errors.length ? `<p class="warning">${errors.map(esc).join("<br>")}</p>` : ""}<div class="notice">重建与安装一致性仅验证内部计算；不能证明关节轴、分组或真实限位正确。真实运动学还需独立多姿态或设备资料验证。</div><h3>构型模板检查</h3><table><thead><tr><th>设备</th><th>结果</th><th>依据</th></tr></thead><tbody>${templateChecks(
      project,
    )
      .map(
        (c) =>
          `<tr><td>${esc(c.name)}</td><td>${esc(c.status)}</td><td>${esc(c.evidence)}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table><h3>设备安装关系</h3><table><thead><tr><th>设备</th><th>安装宿主 link</th><th>状态</th></tr></thead><tbody>${assembly.devices.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.parentLink)}</td><td>${d.confirmed ? "已确认 / 示例已知" : "待确认"}</td></tr>`).join("")}</tbody></table><h3>证据与限制</h3><ul>${project.notes.map((n) => `<li>${esc(n)}</li>`).join("")}<li>全部运动范围为演示值；无厂商限位、零位、速度或力矩恢复。</li><li>未执行物理仿真、碰撞或逆运动学。</li></ul>`,
  );
};
$("close-report").onclick = () => ($("report") as HTMLDialogElement).close();
document.addEventListener("keydown", (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === "z" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName)
  ) {
    e.preventDefault();
    const old = history.pop();
    if (old) load(restoreProject(JSON.parse(old)));
  }
});
viewer.load(project);
render();
