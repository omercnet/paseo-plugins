import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { removeCredential, setCredential } from "../shared/credentials";
import type { createSandbox, removeSandbox, startSandbox, stopSandbox } from "../shared/sandbox";
import type { SandboxProvider } from "./provider";
import { createSandboxService, credentialSummaries } from "./service";
import type { Store } from "./store";

export function createHandlers(provider: SandboxProvider, store: Store) {
  const service = createSandboxService(provider, store);
  const credentials = async () => ({
    credentials: credentialSummaries((await store.read()).credentials),
  });
  return {
    list: ({ paseo }: PluginHandlerContext) => service.list(paseo),
    create: (input: RpcInput<typeof createSandbox>, { paseo }: PluginHandlerContext) =>
      service.create(paseo, input),
    async start({ id }: RpcInput<typeof startSandbox>, { paseo }: PluginHandlerContext) {
      await service.start(paseo, id);
      return {};
    },
    async stop({ id }: RpcInput<typeof stopSandbox>) {
      await service.stop(id);
      return {};
    },
    async remove({ id }: RpcInput<typeof removeSandbox>, { paseo }: PluginHandlerContext) {
      await service.remove(paseo, id);
      return {};
    },
    credentials,
    async setCredential({ name, value }: RpcInput<typeof setCredential>) {
      await store.update((draft) => {
        draft.credentials[name] = { value, savedAt: new Date().toISOString() };
      });
      return credentials();
    },
    async removeCredential({ name }: RpcInput<typeof removeCredential>) {
      await store.update((draft) => {
        delete draft.credentials[name];
      });
      return credentials();
    },
  };
}
