import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type {
  RpcCommand,
  RpcResponse,
  RpcSessionEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type {} from "@oh-my-pi/pi-coding-agent/session/messages";
import type {
  OMP_MESSAGE_REPLAY_POLICIES,
  OMP_RPC_COMMAND_POLICIES,
  OMP_RPC_RESPONSE_POLICIES,
  OMP_SESSION_EVENT_POLICIES,
  OmpMessage,
  OmpRpcEvent,
} from "../server/provider/omp-rpc-protocol";

type AssertExact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<Value extends true> = Value;
type UpstreamMessageRole = Extract<AgentMessage, { role: string }>["role"];
type UpstreamSuccessCommand = Extract<RpcResponse, { success: true }>["command"];

type _MessagePolicyCoverage = AssertTrue<
  AssertExact<UpstreamMessageRole, keyof typeof OMP_MESSAGE_REPLAY_POLICIES>
>;
type _MessageSchemaCoverage = AssertTrue<AssertExact<UpstreamMessageRole, OmpMessage["role"]>>;
// The session event table may classify events added after the pinned runtime, each named here with
// the OMP release that added it. Naming them keeps the check exact otherwise: any other event the
// installed SDK adds or drops still fails here. `omp-sdk-contract.test.ts` fails once the installed
// SDK reaches an entry's release, so the entry is removed when the pin moves past it.
export const SESSION_EVENTS_AFTER_PINNED_RUNTIME = { agent_pause: "18.21.0" } as const;
type SessionEventsAfterPinnedRuntime = keyof typeof SESSION_EVENTS_AFTER_PINNED_RUNTIME;
type _SessionEventPolicyCoverage = AssertTrue<
  AssertExact<
    AgentSessionEvent["type"] | SessionEventsAfterPinnedRuntime,
    keyof typeof OMP_SESSION_EVENT_POLICIES
  >
>;
type _SessionEventSchemaCoverage = AssertTrue<
  AgentSessionEvent["type"] extends OmpRpcEvent["type"] ? true : false
>;
type _RpcSessionEventSchemaCoverage = AssertTrue<
  RpcSessionEventFrame["type"] extends OmpRpcEvent["type"] ? true : false
>;
// Policy tables may intentionally cover commands added after the pinned runtime; every command in
// the installed SDK must still be classified.
type _RpcCommandPolicyCoverage = AssertTrue<
  RpcCommand["type"] extends keyof typeof OMP_RPC_COMMAND_POLICIES ? true : false
>;
type _RpcResponsePolicyCoverage = AssertTrue<
  UpstreamSuccessCommand extends keyof typeof OMP_RPC_RESPONSE_POLICIES ? true : false
>;
