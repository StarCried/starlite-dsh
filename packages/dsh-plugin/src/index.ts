export const name = "dsh-inochi2d-pet";

interface PluginContext {
  on(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  logger?: {
    warn?(message: string): void;
  };
}

/**
 * Compatibility boundary for DSH's developer-preview API. Import and feature
 * failures are contained here so the pet can never prevent DSH from booting.
 */
export async function apply(context: PluginContext): Promise<() => Promise<void>> {
  try {
    const { startDshAdapter } = await import("./adapter.js");
    const dispose = await startDshAdapter(context);
    return async () => {
      await dispose();
    };
  } catch {
    context.logger?.warn?.(
      "DSH Inochi2D Pet is disabled because this DSH build is incompatible or the bridge could not start.",
    );
    return async () => undefined;
  }
}
