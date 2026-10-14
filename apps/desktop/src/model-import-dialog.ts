import helpText from "./model-import-help.md?raw";
import { renderLicenseContent } from "./license-content.js";

export function showModelImportHelp(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "model-license-dialog model-import-dialog";
  dialog.setAttribute("aria-label", "VRM 模型导入说明");
  const title = document.createElement("h2");
  title.textContent = "VRM 模型导入说明";
  const content = renderLicenseContent(helpText);
  content.setAttribute("aria-label", "导入要求与动作说明");
  const actions = document.createElement("div");
  actions.className = "license-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.autofocus = true;
  actions.append(close);
  dialog.append(title, content, actions);
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  close.addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  dialog.showModal();
}
