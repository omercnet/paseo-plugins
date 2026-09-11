import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceMappingOverride, WorkspaceRigMapping } from "../shared";
import { GAS_CITY_LIMITS, WorkspaceRigMappingSchema } from "../shared";
import type { UpstreamCity, UpstreamRig } from "./gas-city-client";

export interface WorkspaceMappingInput {
  workspaceId: string;
  workspacePath: string | null;
  cities: readonly UpstreamCity[];
  rigsByCity: ReadonlyMap<string, readonly UpstreamRig[]>;
  overrides: readonly WorkspaceMappingOverride[];
  canonicalizePath?: (path: string) => Promise<string>;
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function isAncestorPath(ancestor: string, child: string): boolean {
  const delta = relative(ancestor, child);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function diagnostic(code: string, message: string, retryable: boolean) {
  return { code, message, retryable };
}

export async function mapWorkspaceToRig(
  input: WorkspaceMappingInput,
): Promise<WorkspaceRigMapping> {
  const canonicalize = input.canonicalizePath ?? canonicalPath;
  const explicit = input.overrides.find(({ workspaceId }) => workspaceId === input.workspaceId);
  if (explicit) {
    const city = input.cities.find(({ name }) => name === explicit.cityName);
    const rig = input.rigsByCity
      .get(explicit.cityName)
      ?.find(({ name }) => name === explicit.rigName);
    if (!city || !rig) {
      return WorkspaceRigMappingSchema.parse({
        state: "unavailable",
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        cityName: explicit.cityName,
        rigName: explicit.rigName,
        rigPath: null,
        source: "explicit",
        candidates: [],
        diagnostics: [
          diagnostic(
            "mapping-target-unavailable",
            "The explicitly configured Gas City rig is unavailable.",
            true,
          ),
        ],
      });
    }
    return WorkspaceRigMappingSchema.parse({
      state: "mapped",
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      cityName: city.name,
      rigName: rig.name,
      rigPath: rig.path,
      source: "explicit",
      candidates: [{ cityName: city.name, rigName: rig.name, rigPath: rig.path }],
      diagnostics: [],
    });
  }

  if (!input.workspacePath) {
    return WorkspaceRigMappingSchema.parse({
      state: "unmapped",
      workspaceId: input.workspaceId,
      workspacePath: null,
      cityName: null,
      rigName: null,
      rigPath: null,
      source: null,
      candidates: [],
      diagnostics: [
        diagnostic("workspace-path-unavailable", "The Paseo workspace has no local path.", false),
      ],
    });
  }

  const workspacePath = await canonicalize(input.workspacePath);
  const matches: Array<{
    cityName: string;
    rigName: string;
    rigPath: string;
    canonicalRigPath: string;
  }> = [];
  for (const city of input.cities) {
    for (const rig of input.rigsByCity.get(city.name) ?? []) {
      const rigPath = await canonicalize(rig.path);
      if (isAncestorPath(rigPath, workspacePath)) {
        matches.push({
          cityName: city.name,
          rigName: rig.name,
          rigPath: rig.path,
          canonicalRigPath: rigPath,
        });
      }
    }
  }
  matches.sort(
    (left, right) =>
      right.canonicalRigPath.length - left.canonicalRigPath.length ||
      left.cityName.localeCompare(right.cityName) ||
      left.rigName.localeCompare(right.rigName),
  );
  const candidates = matches.slice(0, GAS_CITY_LIMITS.mappingCandidates).map((match) => ({
    cityName: match.cityName,
    rigName: match.rigName,
    rigPath: match.rigPath,
  }));
  const winner = matches[0];
  if (!winner) {
    return WorkspaceRigMappingSchema.parse({
      state: "unmapped",
      workspaceId: input.workspaceId,
      workspacePath,
      cityName: null,
      rigName: null,
      rigPath: null,
      source: null,
      candidates: [],
      diagnostics: [],
    });
  }
  const equallySpecific = matches.filter(
    ({ canonicalRigPath }) => canonicalRigPath.length === winner.canonicalRigPath.length,
  );
  if (equallySpecific.length > 1) {
    return WorkspaceRigMappingSchema.parse({
      state: "ambiguous",
      workspaceId: input.workspaceId,
      workspacePath,
      cityName: null,
      rigName: null,
      rigPath: null,
      source: null,
      candidates,
      diagnostics: [
        diagnostic(
          "ambiguous-rig-mapping",
          "Multiple equally specific Gas City rigs contain this workspace.",
          false,
        ),
      ],
    });
  }
  return WorkspaceRigMappingSchema.parse({
    state: "mapped",
    workspaceId: input.workspaceId,
    workspacePath,
    cityName: winner.cityName,
    rigName: winner.rigName,
    rigPath: winner.rigPath,
    source: "longest-ancestor",
    candidates,
    diagnostics: [],
  });
}
