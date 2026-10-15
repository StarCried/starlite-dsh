export const name = "dsh-starlite";

import { DshStartupError } from "./startup-error.js";

interface PluginContext {
  get?(name: string): unknown;
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
  } catch (error) {
    context.logger?.warn?.(
      error instanceof DshStartupError ? error.message
        : "StarLite for DSH could not start its local status bridge. Restart DSH and check the StarLite installation; DSH will continue without the companion.",
    );
    return async () => undefined;
  }
}
