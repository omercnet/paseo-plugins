/**
 * Ownership fence for an explicit Compose draft. The draft never leaves the
 * local sheet until commit, and a commit is consumed before publication so a
 * repeated press or retained callback cannot insert twice or borrow a
 * replacement page's control.
 */
export function createComposeSession(options: {
  authority(): { enabled: boolean; ownershipKey: string };
  composeText(text: string): boolean;
  cancelInput(): void;
}) {
  let owner: string | null = null;
  return {
    owner: () => owner,
    /** Opening cancels any held canvas input, then binds the draft to current authority. */
    open() {
      options.cancelInput();
      owner = options.authority().ownershipKey;
    },
    close() {
      owner = null;
    },
    /** True only when the text was admitted exactly once; false leaves the draft reviewable. */
    commit(draft: string): boolean {
      const { enabled, ownershipKey } = options.authority();
      if (!enabled || owner === null || owner !== ownershipKey || !draft) return false;
      owner = null;
      if (options.composeText(draft)) return true;
      owner = ownershipKey;
      return false;
    },
  };
}
