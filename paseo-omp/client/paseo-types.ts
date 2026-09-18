import type { PluginClientContext } from "@getpaseo/plugin/client";

type AsyncResult<Callable> = Callable extends (...args: never[]) => Promise<infer Result>
  ? Result
  : never;

export type PaseoApi = PluginClientContext["paseo"];
export type PaseoAgentListResult = AsyncResult<PaseoApi["agents"]["list"]>;
export type PaseoProviderSnapshotResult = AsyncResult<PaseoApi["providers"]["snapshot"]>;
