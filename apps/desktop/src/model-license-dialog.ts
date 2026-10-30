import { t, format } from "./i18n.js";
import { renderLicenseContent } from "./license-content.js";

/** Read-only license access stays available after automatic default setup. */
export function showModelLicense(pack: {title: string; text: string}): void {
  const dialog = document.createElement("dialog");
  dialog.className = "model-license-dialog";
  dialog.setAttribute("aria-label", format("{title}使用许可", {title:pack.title}));
  const title = document.createElement("h2");
  title.textContent = format("{title} · 使用许可", {title:pack.title});
  const notice = document.createElement("p");
  notice.textContent = t("使用本模型即视为同意其许可；如不同意，请在设置中选择“不显示模型”。");
  const license = renderLicenseContent(pack.text);
  const actions = document.createElement("div");
  actions.className = "license-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("关闭");
  close.autofocus = true;
  actions.append(close);
  dialog.append(title, notice, license, actions);
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  close.addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  dialog.showModal();
}

