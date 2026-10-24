import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dockerProvider } from "./server/docker";
import { createHandlers } from "./server/handlers";
import { defaultStatePath, Store } from "./server/store";
import { listCredentials, removeCredential, setCredential } from "./shared/credentials";
import {
  createSandbox,
  listSandboxes,
  removeSandbox,
  startSandbox,
  stopSandbox,
} from "./shared/sandbox";

export default function contribute(server: PluginServerContext) {
  const handlers = createHandlers(dockerProvider, new Store(defaultStatePath()));
  server.handle(listSandboxes, (_input, context) => handlers.list(context));
  server.handle(createSandbox, handlers.create);
  server.handle(startSandbox, handlers.start);
  server.handle(stopSandbox, handlers.stop);
  server.handle(removeSandbox, handlers.remove);
  server.handle(listCredentials, handlers.credentials);
  server.handle(setCredential, handlers.setCredential);
  server.handle(removeCredential, handlers.removeCredential);
  return () => {};
}
