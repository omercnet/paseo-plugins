import { isOmpProfileName, type OmpStore } from "../shared/omp-store";

/** The config screen keeps the id of the retired 0.10 sidebar item so saved links work. */
export const CONFIG_SCREEN_ID = "config";

type ScreenParams = Readonly<Record<string, string>>;

/** A `profile` screen param selects that store; anything invalid falls back to the default. */
export function configStoreFromParams(params: ScreenParams | undefined): OmpStore | undefined {
  const profile = params?.profile?.trim();
  return profile && isOmpProfileName(profile) ? { profile } : undefined;
}

export function configParamsFromStore(store: OmpStore | undefined): Record<string, string> {
  return store?.profile ? { profile: store.profile } : {};
}

export function configScreenTitle(params: ScreenParams): string {
  const store = configStoreFromParams(params);
  return store?.profile ? `OMP · ${store.profile}` : "OMP";
}
