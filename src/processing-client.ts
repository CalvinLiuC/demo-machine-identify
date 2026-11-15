import {
  packProject,
  unpackProject,
  transferBuffers,
  type PackedProject,
} from "./project-transfer.ts";
import type { Project } from "./types.ts";
import type { SceneJob } from "./scene-worker.ts";
import type { Progress } from "./scene-analysis.ts";
import { ANALYSIS_VERSION } from "./scene-analysis.ts";
import { resolveImportUp } from "./import.ts";

function runJob(
  job: Extract<SceneJob, { kind: "export" }>,
  progress: Progress,
): Promise<Uint8Array>;
function runJob(
  job: Exclude<SceneJob, { kind: "export" }>,
  progress: Progress,
): Promise<Project>;
function runJob(
  job: SceneJob,
  progress: Progress,
): Promise<Project | Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scene-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({
      data,
    }: {
      data: {
        kind: string;
        message?: string;
        percent?: number;
        project?: PackedProject;
        bundle?: Uint8Array;
      };
    }) => {
      if (data.kind === "progress") progress(data.message, data.percent);
      if (data.kind === "error") {
        worker.terminate();
        reject(new Error(data.message));
      }
      if (data.kind === "result") {
        worker.terminate();
        try {
          if (data.project?.analysis?.algorithmVersion !== ANALYSIS_VERSION)
            throw new Error(
              "识别线程版本与当前页面不一致，请刷新页面或重启本地服务后重新分析。",
            );
          resolve(unpackProject(data.project));
        } catch (error) {
          reject(error);
        }
      }
      if (data.kind === "bundle") {
        worker.terminate();
        resolve(data.bundle);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "后台几何分析失败"));
    };
    worker.postMessage(
      { ...job, analysisVersion: ANALYSIS_VERSION },
      job.kind === "import-stl" ? [] : transferBuffers(job.project),
    );
  });
}
export function processSTL(
  file: File,
  scale: number,
  up: string,
  progress: Progress = () => {},
): Promise<Project> {
  return runJob(
    { kind: "import-stl", file, scale, up: resolveImportUp(file, up) },
    progress,
  );
}
export function processProject(
  project: Project,
  progress: Progress = () => {},
): Promise<Project> {
  return runJob(
    {
      kind: "analyze",
      project: packProject(project),
      split: !project.analysis,
    },
    progress,
  );
}
export function exportProjectInWorker(
  project: Project,
  progress: Progress = () => {},
): Promise<Uint8Array> {
  return runJob({ kind: "export", project: packProject(project) }, progress);
}
