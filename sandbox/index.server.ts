import type { PluginServerContext } from "@getpaseo/plugin/server";
import { savedCredentials } from "./server/credentials";
import { execDocker } from "./server/docker/cli";
import { createDockerProvider } from "./server/docker/provider";
import { hostGithubToken, hostLoginMounts } from "./server/host-logins";
import { sandboxHosts } from "./server/hosts";
import { createSandboxService } from "./server/service";
import { defaultStatePath, Store } from "./server/store";
import {
  listCredentials,
  listHostLogins,
  removeCredential,
  setCredential,
  setHostLogin,
} from "./shared/credentials";
import {
  createSandbox,
  listSandboxes,
  removeSandbox,
  startSandbox,
  stopSandbox,
} from "./shared/sandbox";

export default function contribute(server: PluginServerContext) {
  const store = new Store(defaultStatePath());
  const sandboxes = createSandboxService(createDockerProvider(execDocker), store, {
    mounts: (enabled) => hostLoginMounts({ enabled }),
    githubToken: () => hostGithubToken(),
  });
  const credentials = savedCredentials(store);

  server.handle(listSandboxes, (_input, { paseo }) => sandboxes.list(sandboxHosts(paseo.hosts)));
  server.handle(createSandbox, (input, { paseo }) =>
    sandboxes.create(sandboxHosts(paseo.hosts), input),
  );
  server.handle(startSandbox, async ({ id }, { paseo }) => {
    await sandboxes.start(sandboxHosts(paseo.hosts), id);
    return {};
  });
  server.handle(stopSandbox, async ({ id }) => {
    await sandboxes.stop(id);
    return {};
  });
  server.handle(removeSandbox, async ({ id }, { paseo }) => {
    await sandboxes.remove(sandboxHosts(paseo.hosts), id);
    return {};
  });
  server.handle(listCredentials, async () => ({ credentials: await credentials.list() }));
  server.handle(setCredential, async ({ name, value }) => ({
    credentials: await credentials.save(name, value),
  }));
  server.handle(removeCredential, async ({ name }) => ({
    credentials: await credentials.remove(name),
  }));
  server.handle(listHostLogins, async () => ({ hostLogins: await credentials.hostLogins() }));
  server.handle(setHostLogin, async ({ id, enabled }) => ({
    hostLogins: await credentials.setHostLogin(id, enabled),
  }));
  return () => {};
}
