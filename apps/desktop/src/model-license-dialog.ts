import { renderLicenseContent } from "./license-content.js";

/** Read-only license access stays available after automatic default setup. */
export function showModelLicense(pack: {title: string; text: string}): void {
  const dialog = document.createElement("dialog");
  dialog.className = "model-license-dialog";
  dialog.setAttribute("aria-label", `${pack.title}使用许可`);
  const title = document.createElement("h2");
  title.textContent = `${pack.title} · 使用许可`;
  const notice = document.createElement("p");
  notice.textContent = "使用本模型即视为同意其许可；如不同意，请在设置中选择“不显示模型”。";
  const license = renderLicenseContent(pack.text);
  const actions = document.createElement("div");
  actions.className = "license-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.autofocus = true;
  actions.append(close);
  dialog.append(title, notice, license, actions);
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  close.addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  dialog.showModal();
}

