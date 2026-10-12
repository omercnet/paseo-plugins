import { useRpc } from "@getpaseo/plugin/client";
import type * as ReactQuery from "@tanstack/react-query";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { POLL_MS, useUsage } from "../client/usage";

vi.mock("@getpaseo/plugin/client", () => ({ useRpc: vi.fn() }));
// useQuery needs a React tree; capture the options the hook builds and run them on a real client.
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof ReactQuery>()),
  useQuery: vi.fn((options: unknown) => options),
}));

function optionsFor(hostId: string, load: () => Promise<unknown>) {
  vi.mocked(useRpc).mockReturnValue(load as never);
  useUsage(hostId);
  return vi.mocked(useQuery).mock.lastCall?.[0] as unknown as {
    queryKey: unknown[];
    queryFn: () => Promise<unknown>;
    refetchInterval: number;
  };
}

describe("useUsage", () => {
  it("polls the plugin every five seconds", () => {
    expect(POLL_MS).toBe(5000);
    expect(optionsFor("a", async () => ({})).refetchInterval).toBe(5000);
  });

  it("keeps each host's readings apart, so switching host never shows another host's numbers", async () => {
    const client = new QueryClient();
    const a = optionsFor("host-a", async () => ({ cpu: 11 }));
    const b = optionsFor("host-b", async () => ({ cpu: 22 }));
    await client.fetchQuery(a);
    await client.fetchQuery(b);
    expect(client.getQueryData(a.queryKey)).toEqual({ cpu: 11 });
    expect(client.getQueryData(b.queryKey)).toEqual({ cpu: 22 });
    expect(a.queryKey).not.toEqual(b.queryKey);
  });

  it("asks the host's own plugin, with no input", async () => {
    const load = vi.fn(async () => ({ cpu: 1 }));
    await optionsFor("a", load).queryFn();
    expect(load).toHaveBeenCalledWith({});
  });
});
