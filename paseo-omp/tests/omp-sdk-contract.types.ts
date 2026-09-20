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
} from "../server/provider/omp-rpc";

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
type _SessionEventPolicyCoverage = AssertTrue<
  AssertExact<AgentSessionEvent["type"], keyof typeof OMP_SESSION_EVENT_POLICIES>
>;
type _SessionEventSchemaCoverage = AssertTrue<
  AgentSessionEvent["type"] extends OmpRpcEvent["type"] ? true : false
>;
type _RpcSessionEventSchemaCoverage = AssertTrue<
  RpcSessionEventFrame["type"] extends OmpRpcEvent["type"] ? true : false
>;
type _RpcCommandPolicyCoverage = AssertTrue<
  AssertExact<RpcCommand["type"], keyof typeof OMP_RPC_COMMAND_POLICIES>
>;
type _RpcResponsePolicyCoverage = AssertTrue<
  AssertExact<UpstreamSuccessCommand, keyof typeof OMP_RPC_RESPONSE_POLICIES>
>;
