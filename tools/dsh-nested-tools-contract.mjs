/** Nested tool events moved to their executor in DSH 0.2.2-rc.1. */
export function nestedToolContract({tools, executor}) {
  // Prefer the current owner even if an old package remains installed: an old
  // declaration must not hide an incompatible change in the active executor.
  const source = executor ?? tools ?? "";
  const requirements = [
    ["nested tool start shape", /interface\s+(?:Code|Ptc)DispatchStartEventData\s*\{[\s\S]{0,260}subCallId:\s*(?:Tool)?CallId;[\s\S]{0,120}name:\s*string;[\s\S]{0,120}arguments:\s*unknown;/u],
    ["nested tool start event", /'tool\/(?:code|ptc)-dispatch-start':\s*(?:Code|Ptc)DispatchStartEventData/u],
    ["nested tool finish event", /'tool\/(?:code|ptc)-dispatch':\s*(?:Code|Ptc)DispatchEventData/u],
  ];
  return requirements.filter(([, pattern]) => !pattern.test(source)).map(([name]) => name);
}
