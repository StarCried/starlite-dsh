const states = ["idle", "working", "completed", "error", "blocked", "approval", "click", "ambient"];
const name = value => typeof value === "string" && value.length > 0;
const pool = value => Array.isArray(value) && value.length <= 20 && new Set(value).size === value.length && value.every(name);

/** Release resources use the current mapping contract, not migrated settings. */
export function validDemoMappings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !states.includes(key))) return false;
  return name(value.idle)
    && ["working", "completed", "error", "blocked", "approval"].every(key => name(value[key]) || value[key] === null)
    && (name(value.click) || value.click === null || pool(value.click))
    && (value.ambient === undefined || pool(value.ambient));
}
