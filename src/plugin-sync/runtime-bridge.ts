export interface PluginManagerRuntime {
  plugins: Record<string, unknown>;
  enabledPlugins?: Set<string>;
  loadManifests?: () => Promise<void>;
  enablePlugin?: (id: string) => Promise<void | boolean>;
  disablePlugin?: (id: string) => Promise<void>;
  installPlugin?: (id: string, ...args: unknown[]) => Promise<unknown>;
  uninstallPlugin?: (id: string, ...args: unknown[]) => Promise<unknown>;
}

export type NativePluginMutation = { id: string; kind: "install" | "uninstall" | "enable" | "disable" };

export class PluginRuntimeBridge {
  private queue: Promise<void> = Promise.resolve();
  private restorers: Array<() => void> = [];
  private mutationsInFlight = new Map<string, number>();
  private mutationVersions = new Map<string, number>();
  private mutationLocks = new Map<string, Promise<void>>();
  private nativePackageMutations = new Map<string, number>();
  private internalLifecycleCalls = new Set<string>();

  constructor(
    private readonly manager: PluginManagerRuntime,
    private readonly selfPluginId: string,
  ) {}

  isLoaded(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.manager.plugins, id);
  }

  savedEnabledIds(): Set<string> | null {
    return this.manager.enabledPlugins instanceof Set ? new Set(this.manager.enabledPlugins) : null;
  }

  setSavedEnabled(id: string, enabled: boolean): void {
    const ids = this.manager.enabledPlugins;
    if (!(ids instanceof Set)) throw new Error("Obsidian enabled plugin state unavailable");
    if (enabled) ids.add(id);
    else ids.delete(id);
  }

  async refreshManifests(): Promise<void> {
    await this.manager.loadManifests?.();
  }

  isMutating(id: string): boolean {
    return (this.mutationsInFlight.get(id) ?? 0) > 0;
  }

  mutationVersion(id: string): number {
    return this.mutationVersions.get(id) ?? 0;
  }

  private isNativePackageMutation(id: string): boolean {
    return (this.nativePackageMutations.get(id) ?? 0) > 0;
  }

  async withMutationLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutationLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.mutationLocks.set(id, queued);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.mutationLocks.get(id) === queued) this.mutationLocks.delete(id);
    }
  }

  private beginMutation(id: string): void {
    this.mutationsInFlight.set(id, (this.mutationsInFlight.get(id) ?? 0) + 1);
    this.mutationVersions.set(id, this.mutationVersion(id) + 1);
  }

  private endMutation(id: string): void {
    const next = (this.mutationsInFlight.get(id) ?? 1) - 1;
    if (next <= 0) this.mutationsInFlight.delete(id);
    else this.mutationsInFlight.set(id, next);
    this.mutationVersions.set(id, this.mutationVersion(id) + 1);
  }

  async unload(id: string): Promise<void> {
    this.assertExternalPlugin(id);
    await this.enqueue(async () => {
      if (!this.isLoaded(id)) return;
      if (!this.manager.disablePlugin) throw new Error("Obsidian disablePlugin API unavailable");
      await this.invokeLifecycle(this.manager.disablePlugin, id);
    });
  }

  async enable(id: string): Promise<void> {
    this.assertExternalPlugin(id);
    await this.enqueue(async () => {
      if (this.isLoaded(id)) return;
      if (!this.manager.enablePlugin) throw new Error("Obsidian enablePlugin API unavailable");
      const result = await this.invokeLifecycle(this.manager.enablePlugin, id);
      if (result === false) throw new Error(`Obsidian failed to enable plugin ${id}`);
    });
  }

  async reload(id: string): Promise<void> {
    this.assertExternalPlugin(id);
    if (!this.isLoaded(id)) return;
    await this.enqueue(async () => {
      if (!this.isLoaded(id)) return;
      if (!this.manager.disablePlugin || !this.manager.enablePlugin) {
        throw new Error("Obsidian plugin lifecycle APIs unavailable");
      }
      await this.invokeLifecycle(this.manager.disablePlugin, id);
      await this.invokeLifecycle(this.manager.enablePlugin, id);
    });
  }

  observeNativeMutations(listener: (event: NativePluginMutation) => void): () => void {
    this.wrapMutation("installPlugin", "install", listener);
    this.wrapMutation("uninstallPlugin", "uninstall", listener);
    this.wrapMutation("enablePlugin", "enable", listener);
    this.wrapMutation("disablePlugin", "disable", listener);
    return () => {
      for (const restore of this.restorers.splice(0)) restore();
    };
  }

  private assertExternalPlugin(id: string): void {
    if (!id || id === this.selfPluginId) throw new Error("Protected plugin cannot be changed by lifecycle bridge");
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.queue.catch(() => undefined).then(action);
    this.queue = next;
    return next;
  }

  private async invokeLifecycle(method: ((id: string) => Promise<void | boolean>) | undefined, id: string): Promise<void | boolean> {
    if (!method) throw new Error("Obsidian plugin lifecycle API unavailable");
    this.internalLifecycleCalls.add(id);
    try {
      return await method.call(this.manager, id);
    } finally {
      this.internalLifecycleCalls.delete(id);
    }
  }

  private wrapMutation(
    methodName: "installPlugin" | "uninstallPlugin" | "enablePlugin" | "disablePlugin",
    kind: NativePluginMutation["kind"],
    listener: (event: NativePluginMutation) => void,
  ): void {
    const original = this.manager[methodName] as ((id: string, ...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof original !== "function") return;
    const bridge = this;
    const wrapped = async function (this: PluginManagerRuntime, id: string, ...args: unknown[]): Promise<unknown> {
      if (id === bridge.selfPluginId) return original.call(this, id, ...args);
      const internalCall = bridge.internalLifecycleCalls.has(id);
      const packageMutation = methodName === "installPlugin" || methodName === "uninstallPlugin";
      const invoke = async () => {
        if (packageMutation) {
          bridge.nativePackageMutations.set(id, (bridge.nativePackageMutations.get(id) ?? 0) + 1);
        }
        bridge.beginMutation(id);
        try {
          return await original.call(this, id, ...args);
        } finally {
          bridge.endMutation(id);
          if (packageMutation) {
            const remaining = (bridge.nativePackageMutations.get(id) ?? 1) - 1;
            if (remaining <= 0) bridge.nativePackageMutations.delete(id);
            else bridge.nativePackageMutations.set(id, remaining);
          }
        }
      };
      if (internalCall) bridge.internalLifecycleCalls.delete(id);
      const nestedLifecycle = !packageMutation && bridge.isNativePackageMutation(id);
      const result = internalCall || nestedLifecycle ? await invoke() : await bridge.withMutationLock(id, invoke);
      if (!internalCall) listener({ id, kind });
      return result;
    };
    const managerRecord = this.manager as unknown as Record<string, unknown>;
    managerRecord[methodName] = wrapped;
    this.restorers.push(() => {
      if (managerRecord[methodName] === wrapped) managerRecord[methodName] = original;
    });
  }
}
