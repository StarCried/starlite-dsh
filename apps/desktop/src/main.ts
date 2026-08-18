import "./style.css";

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
