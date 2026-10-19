/** Public listener declarations used by authenticated loopback Web navigation. */
export function webServerContract(source) {
  const requirements = [
    // Since DSH 0.2.1-rc.2, a listener explicitly has no port before bind.
    // The adapter already rejects an absent/non-integer port at runtime.
    ["loopback web server port", /get\s+port\(\):\s*number(?:\s*\|\s*undefined)?;/u],
    ["loopback web server host", /get\s+host\(\):\s*Config\['host'\];/u],
  ];
  return requirements.filter(([, pattern]) => !pattern.test(source ?? "")).map(([label]) => label);
}
