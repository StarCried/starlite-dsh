import type { LibraryModel, ModelAdjustments, ModelInspection } from "./types.js";

type Group = "idle" | "gaze";
interface AdjustmentField {
  group: Group; key: string; label: string; min: number; max: number; step: number; initial: number;
  capability: "idle" | "fingers" | "head" | "eyes" | "tracking"; advanced?: boolean; unit: "angle" | "percent" | "time";
}
const FIELDS: readonly AdjustmentField[] = [
  {group:"idle",key:"armLiftDegrees",label:"双臂抬高",min:-30,max:45,step:1,initial:0,capability:"idle",unit:"angle"},
  {group:"idle",key:"palmTwistDegrees",label:"掌心朝向",min:-45,max:45,step:1,initial:0,capability:"idle",unit:"angle"},
  {group:"idle",key:"wristLiftDegrees",label:"手腕抬高",min:-45,max:45,step:1,initial:0,capability:"idle",unit:"angle"},
  {group:"idle",key:"handCurl",label:"手部张合",min:0,max:1,step:.01,initial:.25,capability:"fingers",unit:"percent"},
  {group:"gaze",key:"headStrength",label:"转头灵敏度",min:0,max:2,step:.05,initial:1,capability:"head",unit:"percent"},
  {group:"gaze",key:"eyeStrength",label:"眼球灵敏度",min:0,max:2,step:.05,initial:1,capability:"eyes",unit:"percent"},
  {group:"idle",key:"elbowBendDegrees",label:"肘部弯曲",min:-20,max:45,step:1,initial:0,capability:"idle",unit:"angle",advanced:true},
  {group:"gaze",key:"smoothingMs",label:"跟随平滑时间",min:20,max:1000,step:10,initial:100,capability:"tracking",unit:"time",advanced:true},
];
const clone = (value: ModelAdjustments | undefined): ModelAdjustments => structuredClone(value ?? {});
const record = (value: ModelAdjustments, group: Group) => value[group] as Record<string, number> | undefined;

/** Small model-local editor; preview is transient, native persistence is debounced. */
export class ModelAdjustmentsPanel {
  readonly #details = document.createElement("details");
  readonly #title = document.createElement("p");
  readonly #hint = document.createElement("p");
  readonly #status = document.createElement("p");
  readonly #rows = new Map<AdjustmentField, {input: HTMLInputElement; output: HTMLOutputElement; reset: HTMLButtonElement; hint: HTMLElement}>();
  readonly #reset = document.createElement("button");
  readonly #reports = new Map<string, Promise<ModelInspection>>();
  #model: LibraryModel | undefined;
  #draft: ModelAdjustments = {};
  #report: ModelInspection | undefined;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending = new Map<string, number>();
  #lastSaved = "{}";

  constructor(readonly host: HTMLElement, readonly inspect: (model: LibraryModel) => Promise<ModelInspection>,
    readonly preview: (modelId: string, adjustments: ModelAdjustments) => void,
    readonly persist: (modelId: string, adjustments: ModelAdjustments) => Promise<unknown>) {
    this.#details.id = "model-adjustments";
    const summary = document.createElement("summary"); summary.textContent = "姿态与跟随";
    this.#title.className = "adjustments-model";
    this.#hint.className = "adjustments-hint";
    this.#status.className = "adjustments-status"; this.#status.setAttribute("role", "status");
    const basic = document.createElement("div"); basic.className = "adjustments-fields";
    const advanced = document.createElement("details"); advanced.className = "adjustments-advanced";
    const more = document.createElement("summary"); more.textContent = "更多调节";
    const extra = document.createElement("div"); extra.className = "adjustments-fields"; advanced.append(more, extra);
    this.#details.append(summary, this.#title, this.#hint, basic, advanced);
    for (const field of FIELDS) {
      const row = document.createElement("div"); row.className = "adjustment-row";
      const id = "adjust-" + field.key;
      const label = document.createElement("label"); label.htmlFor = id; label.textContent = field.label;
      const output = document.createElement("output"); output.htmlFor = id;
      const input = document.createElement("input"); input.type = "range"; input.id = id;
      input.min = String(field.min); input.max = String(field.max); input.step = String(field.step); input.setAttribute("aria-label", field.label);
      const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "还原"; reset.setAttribute("aria-label", "还原" + field.label);
      const hint = document.createElement("small"); hint.id = id + "-hint"; input.setAttribute("aria-describedby", hint.id);
      input.addEventListener("input", () => this.#edit(field, Number(input.value), false));
      input.addEventListener("change", () => this.#edit(field, Number(input.value), true));
      input.addEventListener("blur", () => this.#flush());
      reset.addEventListener("click", () => this.#edit(field, undefined, true));
      row.append(label, output, input, reset, hint); (field.advanced ? extra : basic).append(row);
      this.#rows.set(field, {input, output, reset, hint});
    }
    this.#reset.type = "button"; this.#reset.className = "adjustments-reset"; this.#reset.textContent = "恢复此模型默认值";
    this.#reset.addEventListener("click", () => { this.#draft = {}; this.#changed(true); });
    this.#details.append(this.#reset, this.#status); host.append(this.#details);
    this.#details.addEventListener("toggle", () => { if (this.#details.open) void this.#checkCapabilities(); });
  }

  update(model: LibraryModel | undefined): void {
    const changed = this.#model?.id !== model?.id;
    if (changed) {
      this.#flush(); ++this.#generation; this.#report = undefined; this.#status.textContent = "";
    }
    this.#model = model;
    this.host.hidden = !model || model.backend !== "vrm";
    if (changed || !this.#pending.get(model?.id ?? "") && this.#timer === undefined) {
      this.#draft = clone(model?.adjustments); this.#lastSaved = JSON.stringify(this.#draft);
    }
    this.#render();
    if (changed && this.#details.open) void this.#checkCapabilities();
  }

  destroy(): void { this.#flush(); ++this.#generation; }
  flush(): void { this.#flush(); }

  #edit(field: AdjustmentField, value: number | undefined, immediate: boolean): void {
    if (!this.#model) return;
    const group = {...record(this.#draft, field.group)};
    if (value === undefined) delete group[field.key]; else group[field.key] = value;
    this.#draft = {...this.#draft};
    if (Object.keys(group).length) this.#draft[field.group] = group; else delete this.#draft[field.group];
    this.#changed(immediate);
  }

  #changed(immediate: boolean): void {
    if (!this.#model) return;
    this.preview(this.#model.id, clone(this.#draft)); this.#render();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (immediate) this.#flush(); else this.#timer = setTimeout(() => { this.#timer = undefined; this.#flush(); }, 200);
  }

  #flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const model = this.#model, adjustments = clone(this.#draft), signature = JSON.stringify(adjustments);
    if (!model || signature === this.#lastSaved) return;
    this.#lastSaved = signature;
    this.#pending.set(model.id, (this.#pending.get(model.id) ?? 0) + 1);
    void this.persist(model.id, adjustments).catch(() => {
      if (this.#model?.id === model.id && JSON.stringify(this.#draft) === signature) {
        this.#draft = clone(this.#model.adjustments); this.#lastSaved = JSON.stringify(this.#draft);
        this.preview(model.id, clone(this.#draft)); this.#render();
        this.#status.textContent = "调节未保存，已恢复保存的设置。";
      }
    }).finally(() => { this.#pending.set(model.id, Math.max(0, (this.#pending.get(model.id) ?? 1) - 1)); });
  }

  async #checkCapabilities(): Promise<void> {
    const model = this.#model, generation = this.#generation;
    if (!model || this.#report) return;
    this.#status.textContent = "正在检查模型能力…";
    let request = this.#reports.get(model.id);
    if (!request) { request = this.inspect(model); this.#reports.set(model.id, request); }
    try {
      const report = await request;
      if (generation !== this.#generation) return;
      this.#report = report; this.#status.textContent = ""; this.#render();
    } catch {
      this.#reports.delete(model.id);
      if (generation === this.#generation) this.#status.textContent = "无法检查模型能力，请收起后重新展开。";
    }
  }

  #render(): void {
    const model = this.#model, caps = this.#report?.capabilities;
    const builtIn = model?.mappings.idle === "StarLiteIdle";
    const fingers = caps?.humanoid.optionalBones.filter(name => /(?:Thumb|Index|Middle|Ring|Little)(?:Metacarpal|Proximal|Intermediate|Distal)$/u.test(name)).length ?? 0;
    this.#title.textContent = model?.title ?? "";
    this.#hint.textContent = builtIn ? "姿态调节只作用于 StarLite 默认站姿，不改变其他动作。" : "当前待机使用模型自带动作，保留原有姿态；视线仍可调节。";
    for (const [field, row] of this.#rows) {
      const value = record(this.#draft, field.group)?.[field.key];
      row.input.value = String(value ?? field.initial);
      row.output.textContent = field.key === "handCurl" && value === undefined ? "原动作" : field.unit === "angle" ? `${value ?? field.initial}°` : field.unit === "time" ? `${value ?? field.initial} ms` : `${Math.round((value ?? field.initial) * 100)}%`;
      const allowed = !!caps && (field.capability === "idle" ? builtIn : field.capability === "fingers" ? builtIn && fingers > 0 : field.capability === "eyes" ? caps.lookAt.eyes : field.capability === "head" ? caps.lookAt.head : caps.lookAt.head || caps.lookAt.eyes);
      row.input.disabled = !allowed; row.reset.disabled = value === undefined;
      row.hint.textContent = !caps ? "展开后检查模型能力" : (field.capability === "idle" || field.capability === "fingers") && !builtIn ? "仅用于 StarLite 默认站姿" : field.capability === "fingers" ? fingers === 0 ? "未配置标准手指骨骼" : fingers < 30 ? "仅调整已映射的手指；0% 张开，100% 握拳" : "0% 张开，100% 握拳；还原后保留原动作" : field.capability === "eyes" && !caps.lookAt.eyes ? "未配置有效眼球骨骼或视线表情" : field.capability === "eyes" && (!caps.lookAt.horizontal || !caps.lookAt.vertical) ? "按模型支持的视线方向调节" : field.key === "smoothingMs" ? "数值越小，跟随越快" : field.group === "gaze" ? "0% 不跟随；仍保留角度限制" : "";
    }
    this.#reset.disabled = !Object.keys(this.#draft).length;
  }
}
