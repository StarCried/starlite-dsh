/** Select the public browser entry instead of Node's conditional ./client export. */
export function browserClientEntry(exports) {
  const client = exports?.["./client"];
  const entry = typeof client === "string" ? client : client?.browser ?? client?.default;
  if (typeof entry !== "string" || !entry.startsWith("./") || entry.split("/").includes("..")) {
    throw Error("DSH browser client export unavailable");
  }
  return entry;
}
