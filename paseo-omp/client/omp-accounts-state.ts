import type {
  OmpAccount,
  OmpAccountProvider,
  OmpAccountsView,
  OmpBalancePreview,
  OmpLogin,
} from "../shared/omp-accounts";

export interface OmpAccountGroup {
  provider: OmpAccountProvider;
  accounts: OmpAccount[];
}

const OPEN_LOGIN_POLL_MS = 1_000;
const IDLE_POLL_MS = 30_000;

/** Providers that have at least one login, in OMP's provider order; a login's own id names an unlisted provider. */
export function accountGroups(view: OmpAccountsView): OmpAccountGroup[] {
  const known = new Map(view.providers.map((provider) => [provider.id, provider]));
  const ids = [...new Set(view.accounts.map((account) => account.provider))];
  const order = new Map(view.providers.map((provider, index) => [provider.id, index]));
  const sorted = ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return sorted.map((id) => ({
    provider: known.get(id) ?? { id, name: id, authenticated: true },
    accounts: view.accounts.filter((account) => account.provider === id),
  }));
}

/** Signed-in providers first, because adding a second login to one is the common case. */
export function signInProviders(
  providers: readonly OmpAccountProvider[],
  query: string,
): OmpAccountProvider[] {
  const needle = query.trim().toLocaleLowerCase();
  const matching = providers.filter(
    (provider) =>
      needle === "" ||
      provider.name.toLocaleLowerCase().includes(needle) ||
      provider.id.includes(needle),
  );
  return matching.toSorted(
    (a, b) => Number(b.authenticated) - Number(a.authenticated) || a.name.localeCompare(b.name),
  );
}

export function loginIsOpen(login: OmpLogin): boolean {
  return login.step === "starting" || login.step === "waiting" || login.step === "verifying";
}

/** Polls quickly while a sign-in is moving, otherwise slowly: the server already caches reads. */
export function accountsPollInterval(view: OmpAccountsView | undefined): number {
  return view?.logins.some(loginIsOpen) ? OPEN_LOGIN_POLL_MS : IDLE_POLL_MS;
}

export function usedPercent(usedFraction: number): number {
  return Math.min(100, Math.round(usedFraction * 100));
}

export function balanceLine(preview: OmpBalancePreview): string {
  const shares = preview.shares.map((share) => `${share.label} ${share.percent}%`);
  return `New agents on ${preview.model} go to ${shares.length > 0 ? shares.join(", ") : "no login"}`;
}

export function resetsLabel(resets: NonNullable<OmpAccount["resets"]>): string {
  const noun = resets.available === 1 ? "reset" : "resets";
  return `${resets.available} banked ${noun}`;
}
