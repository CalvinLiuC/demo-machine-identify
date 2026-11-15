import type { Project } from "./types.ts";

export const templates = {
  P: { name: "直线导轨", revolute: 0, prismatic: 1, independent: 1 },
  "6R": { name: "六轴串联机器人", revolute: 6, prismatic: 0, independent: 6 },
  "2P-mimic": {
    name: "对称平行夹爪",
    revolute: 0,
    prismatic: 2,
    independent: 1,
  },
  static: {
    name: "刚性工具 / 静态结构",
    revolute: 0,
    prismatic: 0,
    independent: 0,
  },
} as const;

export function templateChecks(p: Project) {
  return p.devices.map((d) => {
    const spec = templates[d.template as keyof typeof templates];
    const links = p.links.filter((l) => l.device === d.id),
      moving = links.filter((l) => l.joint.type !== "fixed");
    const actual = {
      revolute: moving.filter((l) => l.joint.type === "revolute").length,
      prismatic: moving.filter((l) => l.joint.type === "prismatic").length,
      independent: moving.filter((l) => !l.joint.mimic).length,
    };
    if (!spec)
      return {
        device: d.id,
        name: d.name,
        status: "未知构型",
        evidence: "尚未选择受支持模板",
        actual,
      };
    const issues: string[] = [];
    for (const key of ["revolute", "prismatic", "independent"] as const)
      if (actual[key] !== spec[key])
        issues.push(`${key}: 预期 ${spec[key]}，实际 ${actual[key]}`);
    if (d.template === "6R") {
      for (const link of links)
        if (links.filter((l) => l.parent === link.id).length > 1)
          issues.push("6R 模板要求串联链，检测到分支");
    }
    if (d.template === "2P-mimic" && moving.length === 2) {
      if (moving[0].parent !== moving[1].parent)
        issues.push("平行夹爪模板要求两指连接同一本体");
      const source = moving.find((l) => !l.joint.mimic),
        follower = moving.find((l) => l.joint.mimic);
      if (!source || !follower || follower.joint.mimic !== source.id)
        issues.push("需要确认两指的直接线性联动");
    }
    return {
      device: d.id,
      name: d.name,
      status: issues.length ? "待补全 / 结构不符" : "拓扑匹配",
      evidence:
        issues.join("；") ||
        "仅通过关节数量与连接结构检查，不证明几何、轴线、零位或限位正确。",
      actual,
    };
  });
}
