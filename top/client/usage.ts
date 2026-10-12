import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { getUsage } from "../shared/usage";

export const SCREEN_ID = "usage";
export const POLL_MS = 5000;

export function useUsage(hostId: string) {
  const loadUsage = useRpc(getUsage);
  // The host id keys the cache so a host switch never shows another host's numbers.
  return useQuery({
    queryKey: ["top", hostId, "usage"],
    queryFn: () => loadUsage({}),
    refetchInterval: POLL_MS,
  });
}
