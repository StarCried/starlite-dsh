import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { setUiLocale, translateTemplate } from "./i18n.js";

// Resolve before dynamically importing modules with application-owned labels.
// Native tray and WebView use the same Windows display language.
setUiLocale(await invoke<string>("get_ui_locale").catch(() => navigator.language));
translateTemplate(document.body);

const settingsView = new URLSearchParams(location.search).get("view") === "settings";
const pet = document.getElementById("pet-view");
const settings = document.getElementById("settings-view");

if (settingsView) {
  if (pet) pet.hidden = true;
  if (settings) settings.hidden = false;
  const { startSettings } = await import("./settings.js");
  await startSettings();
} else {
  if (pet) pet.hidden = false;
  if (settings) settings.hidden = true;
  const { startPet } = await import("./pet.js");
  await startPet();
}
