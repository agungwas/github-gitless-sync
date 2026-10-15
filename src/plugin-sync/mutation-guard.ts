import { PluginRuntimeBridge } from "./runtime-bridge";

export class PluginMutationChangedError extends Error {}

/**
 * Runs `action` under the plugin's mutation lock, aborting if a native
 * mutation touched the plugin since `expectedVersion` was read.
 * Returns false when the package changed underneath the caller.
 */
export async function withStableMutation(
  runtime: PluginRuntimeBridge,
  id: string,
  expectedVersion: number,
  action: () => Promise<void>,
): Promise<boolean> {
  try {
    await runtime.withMutationLock(id, async () => {
      if (runtime.mutationVersion(id) !== expectedVersion || runtime.isMutating(id)) {
        throw new PluginMutationChangedError(`Native package changed during reconciliation: ${id}`);
      }
      await action();
    });
    return true;
  } catch (error) {
    if (error instanceof PluginMutationChangedError) return false;
    throw error;
  }
}
