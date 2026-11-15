import { importSTL } from "./import.ts";
import {
  decomposeScene,
  recognizeScene,
  ANALYSIS_VERSION,
} from "./scene-analysis.ts";
import {
  packProject,
  unpackProject,
  transferBuffers,
  type PackedProject,
} from "./project-transfer.ts";
import { exportBundle } from "./export.ts";

export type SceneJob = (
  | { kind: "import-stl"; file: File; scale: number; up: string }
  | { kind: "analyze"; project: PackedProject; split: boolean }
  | { kind: "export"; project: PackedProject }
) & { analysisVersion?: string };
const scope = self as unknown as {
  onmessage: (event: MessageEvent<SceneJob>) => void;
  postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    if (data.analysisVersion && data.analysisVersion !== ANALYSIS_VERSION)
      throw Error("识别线程版本与当前页面不一致，请刷新页面或重启本地服务。");
    const progress = (message: string, percent: number) =>
      scope.postMessage({ kind: "progress", message, percent });
    if (data.kind === "export") {
      const bundle = exportBundle(unpackProject(data.project), progress);
      scope.postMessage({ kind: "bundle", bundle }, [
        bundle.buffer as ArrayBuffer,
      ]);
      return;
    }
    progress("解析场景网格", 2);
    const p =
      data.kind === "import-stl"
        ? await importSTL(data.file, data.scale, data.up)
        : unpackProject(data.project);
    const before =
      data.kind === "import-stl" || data.split
        ? decomposeScene(p, progress)
        : (p.analysis?.sourceMeshCount ?? p.meshes.length);
    p.analysis = recognizeScene(p, before, progress);
    p.notes.push(
      `自动几何预处理：${before} 个输入区域拆为 ${p.meshes.length} 个几何连通分量，保留源三角面范围。`,
    );
    const packed = packProject(p);
    scope.postMessage(
      { kind: "result", project: packed },
      transferBuffers(packed),
    );
  } catch (error) {
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
