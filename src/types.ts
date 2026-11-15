import type { BufferGeometry } from "three";
import type { SceneAnalysis } from "./scene-analysis.ts";
export type Vec3 = [number, number, number];
export type JointType = "fixed" | "revolute" | "prismatic";
export interface Joint {
  type: JointType;
  axis?: Vec3;
  value?: number;
  lower?: number;
  upper?: number;
  limitSource?: string;
  source?: string;
  mimic?: string;
  multiplier?: number;
  offset?: number;
  resolution?: "candidate" | "unresolved";
}
export interface Link {
  id: string;
  name: string;
  device: string;
  parent: string | null;
  bind: number[];
  joint: Joint;
  confirmed: boolean;
  kinematicIndex?: number;
}
export interface Device {
  id: string;
  name: string;
  template: string;
}
export interface GeometryItem {
  id: string;
  name: string;
  link: string;
  geometry: BufferGeometry;
  color: string;
  source: unknown;
}
export interface Project {
  version: 1;
  name: string;
  unit: "m";
  reference: string;
  devices: Device[];
  links: Link[];
  meshes: GeometryItem[];
  notes: string[];
  analysis?: SceneAnalysis;
  appliedAnalysisId?: string;
}
