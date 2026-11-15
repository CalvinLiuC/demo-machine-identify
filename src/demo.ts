import * as T from "three";
import { createProject, bindAt } from "./model.ts";
import type { JointType, Vec3 } from "./types.ts";
export function demo() {
  const p = createProject("导轨 · 六轴机器人 · 平行夹爪");
  p.devices = [
    { id: "rail", name: "直线导轨", template: "P" },
    { id: "robot", name: "六轴机器人", template: "6R" },
    { id: "gripper", name: "平行夹爪", template: "2P-mimic" },
  ];
  const add = (
    id: string,
    device: string,
    parent: string,
    point: number[],
    type: JointType = "fixed",
    axis: Vec3 = [0, 0, 1],
    range = [-Math.PI, Math.PI],
  ) =>
    p.links.push({
      id,
      name: id,
      device,
      parent,
      bind: bindAt(point),
      confirmed: true,
      joint: {
        type,
        axis,
        value: 0,
        lower: range[0],
        upper: range[1],
        limitSource: "demo_only",
        source: "内置构型模板；导入姿态为建模零位",
      },
    });
  add("rail_base", "rail", null, [0, 0, 0]);
  add(
    "carriage",
    "rail",
    "rail_base",
    [0, 0, 0.17],
    "prismatic",
    [1, 0, 0],
    [-1.2, 1.2],
  );
  add("robot_base", "robot", "carriage", [0, 0, 0.3]);
  add("axis_1", "robot", "robot_base", [0, 0, 0.52], "revolute");
  add(
    "axis_2",
    "robot",
    "axis_1",
    [0, 0, 0.83],
    "revolute",
    [0, 1, 0],
    [-1.6, 1.6],
  );
  add(
    "axis_3",
    "robot",
    "axis_2",
    [0.18, 0, 1.65],
    "revolute",
    [0, 1, 0],
    [-1.8, 1.8],
  );
  add("axis_4", "robot", "axis_3", [0.88, 0, 1.65], "revolute", [1, 0, 0]);
  add(
    "axis_5",
    "robot",
    "axis_4",
    [1.08, 0, 1.65],
    "revolute",
    [0, 1, 0],
    [-1.7, 1.7],
  );
  add("axis_6", "robot", "axis_5", [1.28, 0, 1.65], "revolute", [1, 0, 0]);
  add("gripper_body", "gripper", "axis_6", [1.36, 0, 1.65]);
  add(
    "finger_left",
    "gripper",
    "gripper_body",
    [1.51, 0.065, 1.65],
    "prismatic",
    [0, 1, 0],
    [0, 0.055],
  );
  add(
    "finger_right",
    "gripper",
    "gripper_body",
    [1.51, -0.065, 1.65],
    "prismatic",
    [0, -1, 0],
    [0, 0.055],
  );
  Object.assign(p.links.at(-1).joint, {
    mimic: "finger_left",
    multiplier: 1,
    offset: 0,
  });
  const mesh = (
    link: string,
    g: T.BufferGeometry,
    point: Vec3,
    color: string,
  ) => {
    g.translate(...point);
    p.meshes.push({
      id: `mesh_${p.meshes.length}`,
      name: link,
      link,
      geometry: g,
      color,
      source: "procedural-demo",
    });
  };
  const box = (l: string, s: Vec3, c: Vec3, color: string) =>
    mesh(l, new T.BoxGeometry(...s), c, color);
  const cyl = (
    l: string,
    r: number,
    h: number,
    c: Vec3,
    color: string,
    axis = "z",
  ) => {
    const g = new T.CylinderGeometry(r, r, h, 40);
    if (axis === "z") g.rotateX(Math.PI / 2);
    if (axis === "x") g.rotateZ(Math.PI / 2);
    mesh(l, g, c, color);
  };
  const arm = (l: string, a: Vec3, b: Vec3, r: number) => {
    const aa = new T.Vector3(...a),
      bb = new T.Vector3(...b),
      d = bb.clone().sub(aa);
    const g = new T.CylinderGeometry(r * 0.8, r, d.length(), 32);
    g.applyQuaternion(
      new T.Quaternion().setFromUnitVectors(
        new T.Vector3(0, 1, 0),
        d.normalize(),
      ),
    );
    mesh(l, g, aa.add(bb).multiplyScalar(0.5).toArray(), "#f5a432");
  };
  box("rail_base", [3.6, 0.55, 0.12], [0, 0, 0.06], "#485b71");
  for (const y of [-0.19, 0.19])
    box("rail_base", [3.5, 0.055, 0.045], [0, y, 0.14], "#bacbd8");
  box("carriage", [0.58, 0.6, 0.14], [0, 0, 0.23], "#399aaf");
  cyl("robot_base", 0.23, 0.22, [0, 0, 0.41], "#d5dce2");
  cyl("axis_1", 0.19, 0.26, [0, 0, 0.65], "#f5a432");
  cyl("axis_2", 0.19, 0.3, [0, 0, 0.83], "#d5dce2", "y");
  arm("axis_2", [0, 0, 0.85], [0.18, 0, 1.65], 0.145);
  cyl("axis_3", 0.16, 0.27, [0.18, 0, 1.65], "#d5dce2", "y");
  arm("axis_3", [0.18, 0, 1.65], [0.88, 0, 1.65], 0.12);
  cyl("axis_4", 0.13, 0.2, [0.92, 0, 1.65], "#f5a432", "x");
  cyl("axis_5", 0.11, 0.2, [1.08, 0, 1.65], "#d5dce2", "y");
  cyl("axis_6", 0.09, 0.18, [1.26, 0, 1.65], "#39495c", "x");
  box("gripper_body", [0.19, 0.23, 0.16], [1.43, 0, 1.65], "#399aaf");
  for (const [l, y] of [
    ["finger_left", 0.065],
    ["finger_right", -0.065],
  ] as [string, number][])
    box(l, [0.2, 0.035, 0.13], [1.59, y, 1.65], "#d5dce2");
  p.notes = [
    "此场景为程序生成的已知机构，用于验证流程，不代表自动识别结果。",
    "所有范围均为演示范围；无厂商零位及限位资料。",
  ];
  return p;
}
