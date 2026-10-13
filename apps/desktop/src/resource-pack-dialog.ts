export interface ResourcePackInspection {
  title: string;
  license: string;
  sha256: string;
  animationCount: number;
}

export function confirmResourceLicense(pack: ResourcePackInspection): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "resource-license";
  dialog.setAttribute("aria-labelledby", "resource-license-title");
  const title = document.createElement("h2");
  title.id = "resource-license-title";
  title.textContent = pack.title;
  const description = document.createElement("p");
  description.textContent = `包含 ${pack.animationCount} 个动作。确认许可后自动导入模型、动作、角色配置与状态映射。`;
  const license = document.createElement("pre");
  license.tabIndex = 0;
  license.setAttribute("aria-label", "资源包使用许可");
  license.textContent = pack.license;
  const actions = document.createElement("div");
  actions.className = "license-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.autofocus = true;
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary";
  accept.textContent = "同意许可并自动导入";
  actions.append(cancel, accept);
  dialog.append(title, description, license, actions);
  return new Promise(resolve => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(accepted);
    };
    cancel.addEventListener("click", () => finish(false));
    accept.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}
