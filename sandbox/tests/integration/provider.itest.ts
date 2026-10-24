import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerProvider } from "../../server/docker";
import { relayConnection } from "../../server/pairing";
import { docker, leftovers, requireDocker, uniqueKey } from "./docker";

const key = uniqueKey();
const first = {
  key,
  revision: "r1",
  env: { PASEO_PASSWORD: "itest-password", GITHUB_TOKEN: "ghp_itest_token" },
};
let handle = "";
const inspect = (format: string) => docker("container", "inspect", "--format", format, handle);

beforeAll(async () => {
  await requireDocker();
  handle = await dockerProvider.up(first, (phase) => console.log(`[provider] ${phase}`));
});
afterAll(async () => {
  await dockerProvider.destroy({ key, handle: null });
  expect(leftovers(key)).toEqual([]);
});

describe("a started sandbox", () => {
  test("is running with a healthy daemon", async () => {
    expect(await dockerProvider.status(handle)).toBe("running");
    expect(inspect("{{.State.Health.Status}}")).toBe("healthy");
  });

  test("is isolated from the host", () => {
    expect(JSON.parse(inspect("{{json .HostConfig.PortBindings}}"))).toEqual({});
    expect(
      JSON.parse(inspect("{{json .Mounts}}")).map((m: { Type: string; Destination: string }) => [
        m.Type,
        m.Destination,
      ]),
    ).toEqual([["volume", "/home/paseo"]]);
    expect(inspect("{{.HostConfig.Privileged}}")).toBe("false");
    expect(inspect("{{json .HostConfig.SecurityOpt}}")).toBe('["no-new-privileges"]');
    expect(JSON.parse(inspect("{{json .HostConfig.CapDrop}}"))).toEqual(["ALL"]);
    expect(inspect("{{json .HostConfig.Binds}}")).not.toContain("docker.sock");
  });

  test("runs agent commands as the unprivileged user with the saved environment", async () => {
    expect((await dockerProvider.exec(handle, ["id", "-un"])).trim()).toBe("paseo");
    expect((await dockerProvider.exec(handle, ["printenv", "GITHUB_TOKEN"])).trim()).toBe(
      "ghp_itest_token",
    );
    expect(
      await dockerProvider.exec(handle, ["test", "-S", "/var/run/docker.sock"]).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("hands stdin to the command", async () => {
    await dockerProvider.exec(handle, ["sh", "-c", "cat > /home/paseo/stdin.txt"], {
      stdin: "from stdin",
    });
    expect(await dockerProvider.exec(handle, ["cat", "/home/paseo/stdin.txt"])).toBe("from stdin");
  });

  test("ships the pinned agent CLIs", async () => {
    const versions = await dockerProvider.exec(handle, [
      "sh",
      "-c",
      "claude --version; codex --version; opencode --version",
    ]);
    expect(versions).toContain("2.1.310");
    expect(versions).toContain("0.164.0");
    expect(versions).toContain("1.19.4");
  });

  test("Git authenticates to github.com from the environment token and nowhere else", async () => {
    const ask = (host: string) =>
      dockerProvider.exec(handle, [
        "sh",
        "-c",
        `printf 'protocol=https\\nhost=${host}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill`,
      ]);
    expect(await ask("github.com")).toContain("password=ghp_itest_token");
    await expect(ask("example.com")).rejects.toThrow();
  });

  test("offers a TLS relay pairing link that becomes a protected connection", async () => {
    const pairing = JSON.parse(
      await dockerProvider.exec(handle, ["paseo", "daemon", "pair", "--relay", "--json"]),
    );
    const connection = new URL(relayConnection(String(pairing.url), "itest-password"));
    expect(connection.protocol).toBe("relay:");
    expect(connection.searchParams.get("ssl")).toBe("true");
    expect(connection.searchParams.get("security")).toBe("protected");
  });
});

describe("the sandbox lifecycle", () => {
  test("stop and start keep the container and the data; new credentials recreate it but keep the data", async () => {
    await dockerProvider.exec(handle, ["sh", "-c", "echo kept > /home/paseo/marker.txt"]);
    const containerId = inspect("{{.Id}}");

    await dockerProvider.stop(handle);
    expect(await dockerProvider.status(handle)).toBe("stopped");
    expect(await dockerProvider.up(first, () => undefined)).toBe(handle);
    expect(inspect("{{.Id}}")).toBe(containerId);
    expect((await dockerProvider.exec(handle, ["cat", "/home/paseo/marker.txt"])).trim()).toBe(
      "kept",
    );

    const rotated = {
      ...first,
      revision: "r2",
      env: { PASEO_PASSWORD: "itest-password", GITHUB_TOKEN: "ghp_rotated" },
    };
    await dockerProvider.up(rotated, () => undefined);
    expect(inspect("{{.Id}}")).not.toBe(containerId);
    expect((await dockerProvider.exec(handle, ["printenv", "GITHUB_TOKEN"])).trim()).toBe(
      "ghp_rotated",
    );
    expect((await dockerProvider.exec(handle, ["cat", "/home/paseo/marker.txt"])).trim()).toBe(
      "kept",
    );
  });

  test("destroy removes the container and its volume, and repeating it is harmless", async () => {
    const other = uniqueKey();
    const otherHandle = await dockerProvider.up({ ...first, key: other }, () => undefined);
    expect(leftovers(other)).toHaveLength(2);
    await dockerProvider.destroy({ key: other, handle: otherHandle });
    expect(leftovers(other)).toEqual([]);
    await expect(
      dockerProvider.destroy({ key: other, handle: otherHandle }),
    ).resolves.toBeUndefined();
  });
});
