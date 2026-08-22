import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface PluginDefinitionSurface {
  setup: (ctx: PluginContext) => Promise<void>;
  onHealth: () => Promise<Record<string, unknown>>;
}

/**
 * The `definePlugin` helper freezes `{ definition }`; the shape of the
 * definition object (setup/onHealth/onShutdown) is not exposed on the exported
 * plugin's public type. This helper recovers the runtime surface for tests.
 */
export function pluginDefinition<T extends { definition: unknown }>(plugin: T): PluginDefinitionSurface {
  return plugin.definition as PluginDefinitionSurface;
}
