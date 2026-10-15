export type StartupFailure = "unsupported-platform" | "incompatible-api";

/** Known startup failures have fixed diagnostics; Host errors may contain secrets. */
export class DshStartupError extends Error {
  constructor(readonly code: StartupFailure) {
    super(code === "unsupported-platform"
      ? "StarLite for DSH requires Windows 11 x64, either directly or through WSL2 x64 on that Windows host. Other platforms and architectures are unsupported; DSH will continue without the companion."
      : "StarLite for DSH is disabled because this DSH build does not provide the required plugin API. Update DSH and StarLite to compatible versions; DSH will continue without the companion.");
    this.name = "DshStartupError";
  }
}
