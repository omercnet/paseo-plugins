import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listCredentials, removeCredential, setCredential } from "../shared/credentials";
import {
  createSandbox,
  listSandboxes,
  removeSandbox,
  startSandbox,
  stopSandbox,
} from "../shared/sandbox";

export const SCREEN_ID = "sandboxes";
export const SETTINGS_ID = "sandbox";
export const POLL_MS = 3000;

/** The host id keys every cache so switching hosts never shows another host's sandboxes. */
export function useSandboxes(hostId: string) {
  const load = useRpc(listSandboxes);
  return useQuery({
    queryKey: ["sandbox", hostId, "list"],
    queryFn: () => load({}),
    refetchInterval: POLL_MS,
  });
}

export function useSandboxActions(hostId: string) {
  const client = useQueryClient();
  const create = useRpc(createSandbox);
  const start = useRpc(startSandbox);
  const stop = useRpc(stopSandbox);
  const remove = useRpc(removeSandbox);
  const refresh = () => client.invalidateQueries({ queryKey: ["sandbox", hostId, "list"] });
  return {
    create: useMutation({ mutationFn: create, onSettled: refresh }),
    start: useMutation({ mutationFn: start, onSettled: refresh }),
    stop: useMutation({ mutationFn: stop, onSettled: refresh }),
    remove: useMutation({ mutationFn: remove, onSettled: refresh }),
  };
}

export function useCredentials(hostId: string) {
  const client = useQueryClient();
  const load = useRpc(listCredentials);
  const save = useRpc(setCredential);
  const clear = useRpc(removeCredential);
  const key = ["sandbox", hostId, "credentials"];
  const query = useQuery({ queryKey: key, queryFn: () => load({}) });
  const publish = (data: RpcOutput<typeof listCredentials>) => {
    client.setQueryData(key, data);
    client.invalidateQueries({ queryKey: ["sandbox", hostId, "list"] });
  };
  return {
    query,
    save: useMutation({ mutationFn: save, onSuccess: publish }),
    clear: useMutation({ mutationFn: clear, onSuccess: publish }),
  };
}
