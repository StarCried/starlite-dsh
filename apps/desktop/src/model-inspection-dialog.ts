import type {ModelInspection} from "./types.js";

type Tone = "excellent" | "good" | "warning" | "high" | "neutral";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text: string, tone: Tone): HTMLSpanElement {
  const node = element("span", "inspection-badge", text);
  node.dataset.tone = tone;
  return node;
}

function metric(label: string, value: string, note: string, rating?: {text: string; tone: Tone}): HTMLElement {
  const card = element("div", "inspection-metric");
  const heading = element("dt", "inspection-metric-heading");
  heading.append(element("span", "", label));
  if (rating) heading.append(badge(rating.text, rating.tone));
  const number = element("dd", "inspection-number", value);
  number.dataset.tone = rating?.tone ?? "neutral";
  card.append(heading, number, element("dd", "inspection-caption", note));
  return card;
}

function capability(label: string, status: string, note: string, tone: Tone): HTMLElement {
  const card = element("div", "inspection-capability");
  const state = element("dd", "inspection-capability-status"); state.append(badge(status, tone));
  card.append(element("dt", "", label), state, element("dd", "inspection-caption", note));
  return card;
}

/** Local, read-only report. Model-provided names are always plain text. */
export function showModelInspection(report: ModelInspection): void {
  const dialog = document.createElement("dialog");
  dialog.className = "model-license-dialog model-inspection-dialog";
  dialog.setAttribute("aria-label", "模型信息");
  const header = element("header", "inspection-header");
  header.append(element("p", "inspection-eyebrow", "STARLITE / VRM"));
  const title = element("h2", "");
  title.textContent = (report.modelName || "VRM 模型") + " · 模型信息";
  const subtitle = element("div", "inspection-subtitle");
  subtitle.append(badge(report.compatibilitySupported ? "可使用" : "需要检查", report.compatibilitySupported ? "good" : "high"), element("span", "", "模型能力与资源概览"));
  header.append(title, subtitle);

  const content = element("div", "inspection-body");
  const metrics = report.metrics;
  const count = (value: number) => value.toLocaleString("en-US");
  // Only this resource count has a comparable VRChat PC reference. It is
  // deliberately not an overall rank, an FPS estimate, or a runtime budget.
  const triangles = metrics?.triangleCount;
  const rating: {text: string; tone: Tone} | undefined = triangles === undefined ? undefined : triangles <= 32000 ? {text:"优秀",tone:"excellent"} : triangles <= 70000 ? {text:"良好",tone:"good"} : {text:"偏高",tone:"high"};
  content.append(element("h3", "inspection-section-title", "资源概览"));
  const overview = element("dl", "inspection-metrics");
  overview.append(
    metric("三角面", triangles === undefined ? "—" : count(triangles), triangles === undefined ? "未提供统计" : "VRChat PC 单项参考", rating),
    metric("模型文件", ((metrics?.fileBytes ?? report.sourceBytes) / 1048576).toFixed(2) + " MiB", "文件体积，不等于运行内存"),
    metric("可用动作", count(report.animations.length), "含程序默认 Idle；数量不参与评级"),
  );
  content.append(overview);

  content.append(element("h3", "inspection-section-title", "基础能力"));
  const capabilities = element("dl", "inspection-capabilities");
  const caps = report.capabilities;
  if (caps) {
    const axes = caps.lookAt.eyes ? Number(caps.lookAt.horizontal) + Number(caps.lookAt.vertical) : 0;
    capabilities.append(
      capability("人形映射", "已识别", `${caps.humanoid.requiredBones.length} 个必需 / ${caps.humanoid.optionalBones.length} 个可选骨骼`, "good"),
      capability("自动眨眼", caps.blink.automatic ? "可用" : "未配置", caps.blink.automatic ? "已识别标准眨眼绑定" : "可选能力，其他功能仍可使用", caps.blink.automatic ? "good" : "neutral"),
      capability("眼球跟随", axes === 2 ? "双轴可用" : axes === 1 ? "部分可用" : "未配置", `水平${caps.lookAt.eyes && caps.lookAt.horizontal ? "可用" : "未配置"} · 垂直${caps.lookAt.eyes && caps.lookAt.vertical ? "可用" : "未配置"}`, axes === 2 ? "good" : axes === 1 ? "warning" : "neutral"),
    );
  } else {
    for (const label of ["人形映射", "自动眨眼", "眼球跟随"]) capabilities.append(capability(label, "未提供检查结果", "重新打开模型信息可检查能力", "neutral"));
  }
  content.append(capabilities);
  if (caps?.lookAt.head) content.append(element("p", "inspection-hint", "头部跟随可用，并有角度限制。其他事件动作需由模型提供并在动作映射中选择。"));

  if ((caps && (!caps.blink.automatic || !caps.lookAt.eyes || !caps.lookAt.horizontal || !caps.lookAt.vertical)) || report.issues.length > 0) {
    const advice = element("section", "inspection-advice");
    advice.append(element("h3", "inspection-section-title", "配置建议"));
    const list = element("ul", "");
    if (caps && !caps.blink.automatic) list.append(element("li", "", "自动眨眼：未配置。请在导出器中绑定标准 Blink，或完整的左右 Blink；仅修改形态键名称无效。"));
    if (caps && (!caps.lookAt.eyes || !caps.lookAt.horizontal || !caps.lookAt.vertical)) list.append(element("li", "", "请配置 VRM lookAt 和眼骨或视线表达，并检查水平、垂直角度范围。"));
    for (const issue of report.issues) {
      const item = element("li", "", issue.message);
      item.dataset.tone = issue.severity === "error" ? "high" : "warning";
      list.append(item);
    }
    advice.append(list); content.append(advice);
  }

  const details = element("details", "inspection-details");
  details.append(element("summary", "", "详细统计与评级说明"));
  if (metrics) {
    const statistics = element("dl", "inspection-statistics");
    for (const [label, value] of [
      ["网格", count(metrics.meshCount)], ["材质", count(metrics.materialCount)], ["绘制分组", count(metrics.primitiveCount)],
      ["顶点引用", count(metrics.vertexCount)], ["形态目标", count(metrics.morphTargetCount)], ["纹理", count(metrics.textureCount)],
      ["图像", count(metrics.imageCount)], ["节点", count(metrics.nodeCount)], ["accessor 逻辑数据", (metrics.decodedAccessorBytes / 1048576).toFixed(2) + " MiB"],
    ]) {
      const item = element("div", ""); item.append(element("dt", "", label), element("dd", "", value)); statistics.append(item);
    }
    details.append(statistics);
  }
  for (const text of [
    "三角面单项参考 VRChat PC 档位：≤ 32,000 为优秀，≤ 70,000 为良好，超过 70,000 标为偏高。它不是 VRChat 的整体评级，也不代表实际帧率。",
    "几何统计按资源 primitive 累加，可能重复引用，不计场景实例的重复绘制。材质数不等于材质槽；绘制分组不等于实际 draw calls；人形映射不等于总骨骼数。其他数量不参与评级。",
    "文件体积与 accessor 逻辑数据不等于 GPU 或进程内存。运行流畅度可在「显示 → 显示性能参数」中查看。",
  ]) details.append(element("p", "inspection-hint", text));
  content.append(details);

  const actions = element("div", "license-actions inspection-actions");
  const close = document.createElement("button"); close.type = "button"; close.textContent = "关闭"; close.autofocus = true;
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  actions.append(close); dialog.append(header, content, actions); document.body.append(dialog); dialog.showModal();
}
