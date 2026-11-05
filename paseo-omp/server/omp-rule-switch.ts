import type { RpcInput } from "@getpaseo/plugin";
import type { setOmpRuleEnabled } from "../shared/omp-rules";
import {
  type OmpListDependencies,
  ompListDependencies,
  requireOmpExecutable,
  writeListEntry,
} from "./omp-list-setting";
import { inOmpScope } from "./omp-rules";
import { runSettingsMutation } from "./omp-settings";
import { OmpPublicError } from "./provider/security";

/** Off adds the rule to `ttsr.disabledRules`; on removes it. A workspace saves the whole project list. */
export async function setOmpRuleEnabledWithDependencies(
  input: RpcInput<typeof setOmpRuleEnabled>,
  dependencies: OmpListDependencies,
): Promise<{ status: "ok" } | { status: "error"; message: string }> {
  try {
    const executable = await requireOmpExecutable(dependencies);
    const change = {
      cwd: input.cwd,
      list: "ttsr.disabledRules" as const,
      entry: input.name,
      enabled: input.enabled,
    };
    await inOmpScope(input.cwd, dependencies, (runIn) =>
      runSettingsMutation(() => writeListEntry(change, dependencies, executable, runIn)),
    );
    return { status: "ok" };
  } catch (error) {
    if (error instanceof OmpPublicError) return { status: "error", message: error.message };
    throw error;
  }
}

export function resolveSetOmpRuleEnabled(input: RpcInput<typeof setOmpRuleEnabled>) {
  return setOmpRuleEnabledWithDependencies(input, ompListDependencies);
}
