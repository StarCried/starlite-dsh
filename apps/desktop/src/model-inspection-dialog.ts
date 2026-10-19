import type {ModelInspection} from "./types.js";

/** Local, read-only report. Model-provided names are always plain text. */
export function showModelInspection(report: ModelInspection): void {
  const dialog = document.createElement("dialog");
  dialog.className = "model-license-dialog";
  dialog.setAttribute("aria-label", "模型信息");
  const title = document.createElement("h2");
  title.textContent = (report.modelName || "VRM 模型") + " · 模型信息";
  const content = document.createElement("div");
  content.className = "license-content";
  const line = (text: string) => {const p = document.createElement("p"); p.textContent = text; content.append(p);};
  const caps = report.capabilities;
  if (caps) {
    line(`人形映射：${caps.humanoid.requiredBones.length} 个必需骨骼，${caps.humanoid.optionalBones.length} 个可选骨骼。`);
    line(caps.blink.automatic ? "自动眨眼：可用。" : "自动眨眼：不可用。请在导出器中绑定标准 Blink，或完整的左右 Blink；仅修改形态键名称无效。其他功能可继续使用。");
    line(caps.lookAt.eyes ? "眼球跟随：可用；头部跟随有角度限制。" : "眼球跟随：未检测到完整配置。请配置 VRM lookAt 和眼骨或视线表达；仍可使用限角头部跟随。");
  }
  line(`可用动作：${report.animations.length} 个（含程序默认 Idle）。其他事件动作需由模型提供并在动作映射中选择。`);
  const metrics = report.metrics;
  line(`文件：${((metrics?.fileBytes ?? report.sourceBytes) / 1048576).toFixed(2)} MiB。`);
  if (metrics) line(`网格 ${metrics.meshCount} · 材质 ${metrics.materialCount} · 三角面 ${metrics.triangleCount.toLocaleString()} · 形态目标 ${metrics.morphTargetCount}。几何统计按 primitive 累加，可能重复；文件与 accessor 大小不等于 GPU 或进程内存。`);
  for (const issue of report.issues) line(issue.message);
  const actions = document.createElement("div"); actions.className = "license-actions";
  const close = document.createElement("button"); close.type = "button"; close.textContent = "关闭"; close.autofocus = true;
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  actions.append(close); dialog.append(title, content, actions); document.body.append(dialog); dialog.showModal();
}
