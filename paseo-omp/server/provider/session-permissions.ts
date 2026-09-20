import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderEvent,
  ProviderInput,
  ProviderPermissionResponse,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { OmpRuntimeSession } from "./omp-rpc";
import type {
  OmpExtensionUiResponse,
  OmpRpcEvent,
  OmpToolApprovalCancel,
  OmpToolApprovalRequest,
} from "./omp-rpc-protocol";
import {
  BoundedStringSet,
  boundedJsonBytes,
  type OmpPublicDataSerializer,
  OmpPublicError,
  utf8Bytes,
} from "./security";
import type { ActiveTurn } from "./session-terminal";
import type { OmpTimelineProjector, OmpTimelineScheduler } from "./timeline-projector";

type SessionPermissionInput = Extract<ProviderInput, { type: "session.permission" }>;
type OmpQuestionRequest = Extract<
  Extract<OmpRpcEvent, { type: "extension_ui_request" }>,
  { method: "select" | "confirm" | "input" | "editor" }
>;
type Emit = (event: ProviderEvent) => void;

const MAX_PENDING_PERMISSIONS = 32;
const MAX_PENDING_PERMISSION_BYTES = 2 * 1024 * 1024;
const MAX_RESOLVED_TOOL_APPROVAL_IDS = 1_024;
const OMP_ASK_USER_FREEFORM_SENTINEL = "✏️ Type custom response...";
const MAX_FREEFORM_RESPONSE_BYTES = 64 * 1024;

type PendingPermission = {
  nativeId: string;
  header: string;
  fingerprint: string;
  optionValues: ReadonlyMap<string, string>;
  actionBehaviors: ReadonlyMap<string, "allow" | "deny">;
  retainedBytes: number;
  displayValues: ReadonlyMap<string, string>;
  generation: number;
  runtime: OmpRuntimeSession;
  expiresAt?: number;
  timer?: unknown;
  turnId?: string;
  request: OmpQuestionRequest;
  freeformSentinel?: string;
};
type PendingToolPermission = {
  nativeId: string;
  toolCallId: string;
  fingerprint: string;
  retainedBytes: number;
  generation: number;
  runtime: OmpRuntimeSession;
  expiresAt?: number;
  timer?: unknown;
  turnId?: string;
};

type PendingFreeformSelection = {
  value: string;
  nativeSelectId: string;
  generation: number;
  runtime: OmpRuntimeSession;
  turnId?: string;
};

function permissionFingerprint(request: OmpQuestionRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("base64url");
}

interface PermissionContext {
  runtime: OmpRuntimeSession;
  generation: number;
  activeTurn: ActiveTurn | null;
  closed: boolean;
  runtimeDead: boolean;
}

interface PermissionHost {
  sessionId: string;
  emit: Emit;
  scheduler: OmpTimelineScheduler;
  dataFilter: OmpPublicDataSerializer;
  projector: OmpTimelineProjector;
  readContext(): PermissionContext;
  handleRuntimeFailure(message?: string): void;
  invalidateRuntime(message: string): void;
  markAgentEvidence(turn: ActiveTurn): void;
  reevaluateDeferredTerminal(): void;
}

export class OmpSessionPermissions {
  private permissionSequence = 0;
  private readonly permissionNamespace = randomUUID();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly inFlightPermissions = new Map<string, PendingPermission>();
  private pendingFreeformSelection: PendingFreeformSelection | null = null;
  private readonly pendingToolPermissions = new Map<string, PendingToolPermission>();
  private readonly inFlightToolPermissions = new Map<string, PendingToolPermission>();
  private readonly resolvedToolApprovalIds = new BoundedStringSet(MAX_RESOLVED_TOOL_APPROVAL_IDS);

  constructor(private readonly host: PermissionHost) {}

  private get id(): string {
    return this.host.sessionId;
  }

  private get runtime(): OmpRuntimeSession {
    return this.host.readContext().runtime;
  }

  private get generation(): number {
    return this.host.readContext().generation;
  }

  private get activeTurn(): ActiveTurn | null {
    return this.host.readContext().activeTurn;
  }

  private get closed(): boolean {
    return this.host.readContext().closed;
  }

  private get runtimeDead(): boolean {
    return this.host.readContext().runtimeDead;
  }

  private get scheduler(): OmpTimelineScheduler {
    return this.host.scheduler;
  }

  private get dataFilter(): OmpPublicDataSerializer {
    return this.host.dataFilter;
  }

  private get projector(): OmpTimelineProjector {
    return this.host.projector;
  }

  private emit(event: ProviderEvent): void {
    this.host.emit(event);
  }

  private handleRuntimeFailure(message?: string): void {
    this.host.handleRuntimeFailure(message);
  }
  private invalidateRuntime(message: string): void {
    this.host.invalidateRuntime(message);
  }

  private markAgentEvidence(turn: ActiveTurn): void {
    this.host.markAgentEvidence(turn);
  }

  private reevaluateDeferredPermissionTerminal(): void {
    this.host.reevaluateDeferredTerminal();
  }

  async respond(input: SessionPermissionInput): Promise<void> {
    const typed = this.pendingToolPermissions.get(input.permissionId);
    if (typed) {
      await this.respondToToolPermission(input, typed);
      return;
    }
    const pending = this.pendingPermissions.get(input.permissionId);
    if (!pending) throw new OmpPublicError("Unknown OMP permission request");
    if (!this.permissionOwnerIsCurrent(pending)) {
      this.pendingPermissions.delete(input.permissionId);
      if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: input.permissionId,
      });
      throw new OmpPublicError("OMP permission request is no longer active");
    }
    const { generation, runtime } = pending;
    this.pendingPermissions.delete(input.permissionId);
    this.inFlightPermissions.set(input.permissionId, pending);
    if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
    try {
      const freeformValue = this.freeformSelection(pending, input.response);
      if (freeformValue !== undefined) {
        this.pendingFreeformSelection = {
          value: freeformValue,
          nativeSelectId: pending.nativeId,
          generation,
          runtime,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
        };
      }
      const response = this.extensionUiResponse(pending, input.response);
      await runtime.respondToExtensionUi(response);
    } catch (error) {
      if (this.pendingFreeformSelection?.nativeSelectId === pending.nativeId) {
        this.pendingFreeformSelection = null;
      }
      if (this.inFlightPermissions.get(input.permissionId) !== pending) return;
      this.inFlightPermissions.delete(input.permissionId);
      if (
        this.permissionOwnerIsCurrent(pending) &&
        generation === this.generation &&
        runtime === this.runtime
      ) {
        this.pendingPermissions.set(input.permissionId, pending);
        this.armPermissionTimeout(input.permissionId, pending);
        throw error;
      }
      return;
    }
    if (this.inFlightPermissions.get(input.permissionId) !== pending) return;
    this.inFlightPermissions.delete(input.permissionId);
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.id,
      permissionId: input.permissionId,
    });
    this.reevaluateDeferredPermissionTerminal();
  }
  private async respondToToolPermission(
    input: SessionPermissionInput,
    pending: PendingToolPermission,
  ): Promise<void> {
    if (!this.permissionOwnerIsCurrent(pending)) {
      this.pendingToolPermissions.delete(input.permissionId);
      if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
      this.resolvedToolApprovalIds.add(pending.nativeId);
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: input.permissionId,
      });
      throw new OmpPublicError("OMP permission request is no longer active");
    }
    if (
      input.response.selectedActionId !== undefined &&
      input.response.selectedActionId !== input.response.behavior
    ) {
      throw new OmpPublicError("OMP permission action is invalid");
    }
    this.pendingToolPermissions.delete(input.permissionId);
    this.inFlightToolPermissions.set(input.permissionId, pending);
    if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
    try {
      await pending.runtime.respondToToolApproval({
        type: "tool_approval_response",
        id: pending.nativeId,
        toolCallId: pending.toolCallId,
        approved: input.response.behavior === "allow",
      });
    } catch (error) {
      if (this.inFlightToolPermissions.get(input.permissionId) !== pending) return;
      this.inFlightToolPermissions.delete(input.permissionId);
      this.resolvedToolApprovalIds.add(pending.nativeId);
      this.emit({
        type: "session.permission_resolved",
        sessionId: this.id,
        permissionId: input.permissionId,
      });
      this.reevaluateDeferredPermissionTerminal();
      throw error;
    }
    if (this.inFlightToolPermissions.get(input.permissionId) !== pending) return;
    this.inFlightToolPermissions.delete(input.permissionId);
    this.resolvedToolApprovalIds.add(pending.nativeId);
    this.emit({
      type: "session.permission_resolved",
      sessionId: this.id,
      permissionId: input.permissionId,
    });
    this.reevaluateDeferredPermissionTerminal();
  }

  submitPendingFreeformSelection(
    request: Extract<OmpQuestionRequest, { method: "input" }>,
  ): boolean {
    const pending = this.pendingFreeformSelection;
    if (!pending) return false;
    this.pendingFreeformSelection = null;
    if (
      pending.generation !== this.generation ||
      pending.runtime !== this.runtime ||
      (pending.turnId !== undefined && this.activeTurn?.turnId !== pending.turnId)
    ) {
      return false;
    }
    void pending.runtime
      .respondToExtensionUi({ type: "extension_ui_response", id: request.id, value: pending.value })
      .catch(() => this.handleRuntimeFailure("OMP freeform response failed"));
    return true;
  }
  private toolPermissionDetail(
    request: OmpToolApprovalRequest,
  ): ProviderToolCallDetail | undefined {
    switch (request.identity.kind) {
      case "shell":
        return {
          type: "shell",
          command: this.dataFilter.text(request.identity.command, 24 * 1024),
        };
      case "edit":
        return {
          type: "edit",
          filePath: this.dataFilter.text(request.identity.paths[0] ?? "", 4_096),
          newString: this.dataFilter.text(request.identity.content, 20 * 1024),
        };
      case "write":
        return {
          type: "write",
          filePath: this.dataFilter.text(request.identity.path, 4_096),
          content: this.dataFilter.text(request.identity.content, 20 * 1024),
        };
      case "other":
        return;
    }
  }

  publishToolPermission(request: OmpToolApprovalRequest): void {
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("base64url");
    if (this.resolvedToolApprovalIds.has(request.id)) {
      this.handleRuntimeFailure("OMP reused a resolved tool approval identifier");
      return;
    }
    for (const pending of [
      ...this.pendingToolPermissions.values(),
      ...this.inFlightToolPermissions.values(),
    ]) {
      if (pending.nativeId !== request.id) continue;
      if (pending.fingerprint !== fingerprint || pending.toolCallId !== request.toolCallId) {
        this.handleRuntimeFailure("OMP changed a pending tool approval request");
      }
      return;
    }
    const pendingCount =
      this.pendingPermissions.size +
      this.inFlightPermissions.size +
      this.pendingToolPermissions.size +
      this.inFlightToolPermissions.size;
    if (pendingCount >= MAX_PENDING_PERMISSIONS) {
      this.resolvedToolApprovalIds.add(request.id);
      void this.runtime
        .respondToToolApproval({
          type: "tool_approval_response",
          id: request.id,
          toolCallId: request.toolCallId,
          cancelled: true,
        })
        .catch(() => this.handleRuntimeFailure());
      return;
    }

    this.permissionSequence += 1;
    const permissionId = `omp:permission:${this.permissionNamespace}:${this.permissionSequence}`;
    const detail = this.toolPermissionDetail(request);
    const filteredInput = this.dataFilter.json(request.input, 8 * 1024, 32 * 1024);
    const input =
      filteredInput && typeof filteredInput === "object" && !Array.isArray(filteredInput)
        ? filteredInput
        : {};
    const descriptionParts = [
      request.detail.reason,
      ...request.detail.lines,
      ...(request.detail.providerSafetyChecks ?? []),
    ].filter((part): part is string => Boolean(part));
    const publicRequest = {
      id: permissionId,
      name: `omp.${this.dataFilter.text(request.toolName, 256)}`,
      kind: "tool" as const,
      title: `Allow ${this.dataFilter.text(request.toolName, 256)}?`,
      ...(descriptionParts.length > 0
        ? { description: this.dataFilter.text(descriptionParts.join("\n"), 16 * 1024) }
        : {}),
      input: {
        ...input,
        identity: this.dataFilter.json(request.identity, 20 * 1024, 32 * 1024),
        tier: request.tier,
        toolCallId: request.toolCallId,
      },
      ...(detail ? { detail } : {}),
      actions: [
        { id: "allow", label: "Allow", behavior: "allow" as const, variant: "primary" as const },
        { id: "deny", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
      ],
      metadata: {
        tier: request.tier,
        redacted: request.detail.redacted,
        truncated: request.detail.truncated,
        redactedFields: request.detail.redactedFields,
        truncatedFields: request.detail.truncatedFields,
      },
    };
    const pending: PendingToolPermission = {
      nativeId: request.id,
      toolCallId: request.toolCallId,
      fingerprint,
      retainedBytes: boundedJsonBytes(
        publicRequest,
        MAX_PENDING_PERMISSION_BYTES,
        512,
        MAX_PENDING_PERMISSION_BYTES,
        4_096,
      ),
      generation: this.generation,
      runtime: this.runtime,
      ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
      ...(request.timeout !== undefined ? { expiresAt: Date.now() + request.timeout } : {}),
    };
    let retainedBytes = pending.retainedBytes;
    for (const item of this.pendingPermissions.values()) retainedBytes += item.retainedBytes;
    for (const item of this.inFlightPermissions.values()) retainedBytes += item.retainedBytes;
    for (const item of this.pendingToolPermissions.values()) retainedBytes += item.retainedBytes;
    for (const item of this.inFlightToolPermissions.values()) retainedBytes += item.retainedBytes;
    if (
      pending.retainedBytes === Number.POSITIVE_INFINITY ||
      retainedBytes > MAX_PENDING_PERMISSION_BYTES
    ) {
      void this.runtime
        .respondToToolApproval({
          type: "tool_approval_response",
          id: request.id,
          toolCallId: request.toolCallId,
          cancelled: true,
        })
        .catch(() => this.handleRuntimeFailure());
      this.resolvedToolApprovalIds.add(request.id);
      return;
    }
    this.pendingToolPermissions.set(permissionId, pending);
    this.armToolPermissionTimeout(permissionId, pending);
    this.projector.markAskPermissionRendered();
    if (this.activeTurn) {
      this.activeTurn.awaitingPermissionEvidence = true;
      this.markAgentEvidence(this.activeTurn);
    }
    this.emit({ type: "session.permission", sessionId: this.id, request: publicRequest });
  }

  cancelToolPermission(request: OmpToolApprovalCancel): void {
    for (const permissions of [this.pendingToolPermissions, this.inFlightToolPermissions]) {
      for (const [permissionId, pending] of permissions) {
        if (pending.nativeId !== request.targetId) continue;
        if (pending.toolCallId !== request.toolCallId) {
          this.handleRuntimeFailure("OMP tool approval cancellation did not match its tool call");
          return;
        }
        permissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        this.resolvedToolApprovalIds.add(pending.nativeId);
        this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
        this.reevaluateDeferredPermissionTerminal();
        return;
      }
    }
    if (!this.resolvedToolApprovalIds.has(request.targetId)) {
      this.handleRuntimeFailure("OMP canceled an unknown tool approval request");
    }
  }

  publishPermission(request: OmpQuestionRequest): void {
    if (request.method === "select" && !request.options?.length) {
      this.handleRuntimeFailure();
      return;
    }
    const fingerprint = permissionFingerprint(request);
    let existingId: string | undefined;
    let existingPending: PendingPermission | undefined;
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.nativeId !== request.id) continue;
      if (pending.fingerprint === fingerprint) {
        existingId = permissionId;
        existingPending = pending;
      } else {
        this.pendingPermissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
      }
      break;
    }
    if (!existingId) {
      for (const pending of this.inFlightPermissions.values()) {
        if (pending.nativeId !== request.id) continue;
        if (pending.fingerprint !== fingerprint) this.handleRuntimeFailure();
        return;
      }
    }
    if (
      !existingId &&
      this.pendingPermissions.size +
        this.inFlightPermissions.size +
        this.pendingToolPermissions.size +
        this.inFlightToolPermissions.size >=
        MAX_PENDING_PERMISSIONS
    ) {
      this.rejectPermissionRequest(request, "Too many OMP questions are already pending");
      return;
    }
    if (existingPending?.timer !== undefined) this.scheduler.clear(existingPending.timer);
    if (!existingId) this.permissionSequence += 1;
    const id =
      existingId ?? `omp:permission:${this.permissionNamespace}:${this.permissionSequence}`;
    const header = this.dataFilter.text(request.title ?? "OMP question", 4_096);
    const freeformSentinel =
      request.method === "select" && request.options.includes(OMP_ASK_USER_FREEFORM_SENTINEL)
        ? OMP_ASK_USER_FREEFORM_SENTINEL
        : undefined;
    const optionValues = new Map<string, string>();
    const displayValues = new Map<string, string>();
    const usedOptionLabels = new Set<string>();
    const optionDetails = request.method === "select" ? request.optionDetails : undefined;
    const selectableOptions =
      request.method === "select"
        ? request.options.flatMap((nativeValue, index) =>
            nativeValue === freeformSentinel ? [] : [{ nativeValue, index }],
          )
        : [];
    const options =
      request.method === "select"
        ? selectableOptions.map(({ nativeValue, index }) => {
            const baseLabel = this.dataFilter.text(nativeValue, 4_096);
            let label = baseLabel;
            let suffix = 2;
            while (usedOptionLabels.has(label)) {
              label = `${baseLabel} (${suffix})`;
              suffix += 1;
            }
            usedOptionLabels.add(label);
            const value = `${id}:option:${index}`;
            optionValues.set(value, nativeValue);
            displayValues.set(label, nativeValue);
            return {
              label,
              value,
              ...(optionDetails?.[index]?.description
                ? {
                    description: this.dataFilter.text(
                      optionDetails[index]?.description ?? "",
                      16_384,
                    ),
                  }
                : {}),
            };
          })
        : undefined;
    const questionOptions =
      request.method === "confirm" ? [{ label: "Yes" }, { label: "No" }] : (options ?? []);
    const actions =
      request.method === "select"
        ? [
            ...(options ?? []).map((option) => ({
              id: option.value,
              label: option.label,
              behavior: "allow" as const,
              variant: "secondary" as const,
            })),
            {
              id: "cancel",
              label: "Cancel",
              behavior: "deny" as const,
              variant: "secondary" as const,
            },
          ]
        : [
            {
              id: "submit",
              label: request.method === "confirm" ? "Confirm" : "Submit",
              behavior: "allow" as const,
              variant: "primary" as const,
            },
            {
              id: "cancel",
              label: "Cancel",
              behavior: "deny" as const,
              variant: "secondary" as const,
            },
          ];
    const pending: PendingPermission = {
      nativeId: request.id,
      header,
      fingerprint,
      optionValues,
      actionBehaviors: new Map(actions.map((action) => [action.id, action.behavior])),
      displayValues,
      generation: this.generation,
      runtime: this.runtime,
      request,
      retainedBytes: boundedJsonBytes(
        { request, header, options: questionOptions, actions },
        MAX_PENDING_PERMISSION_BYTES,
        512,
        MAX_PENDING_PERMISSION_BYTES,
        4_096,
      ),
      ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
      ...(request.timeout !== undefined ? { expiresAt: Date.now() + request.timeout } : {}),
      ...(freeformSentinel ? { freeformSentinel } : {}),
    };
    let retainedPermissionBytes = pending.retainedBytes;
    for (const [permissionId, retained] of this.pendingPermissions) {
      if (permissionId !== existingId) retainedPermissionBytes += retained.retainedBytes;
    }
    for (const retained of this.inFlightPermissions.values()) {
      retainedPermissionBytes += retained.retainedBytes;
    }
    for (const retained of this.pendingToolPermissions.values()) {
      retainedPermissionBytes += retained.retainedBytes;
    }
    for (const retained of this.inFlightToolPermissions.values()) {
      retainedPermissionBytes += retained.retainedBytes;
    }
    if (
      pending.retainedBytes === Number.POSITIVE_INFINITY ||
      retainedPermissionBytes > MAX_PENDING_PERMISSION_BYTES
    ) {
      if (existingId) {
        this.pendingPermissions.delete(existingId);
        this.emit({
          type: "session.permission_resolved",
          sessionId: this.id,
          permissionId: existingId,
        });
      }
      this.rejectPermissionRequest(request, "OMP question data exceeded the pending input budget");
      return;
    }
    this.pendingPermissions.set(id, pending);
    this.armPermissionTimeout(id, pending);
    this.projector.markAskPermissionRendered();
    if (this.activeTurn) {
      this.activeTurn.awaitingPermissionEvidence = true;
      this.markAgentEvidence(this.activeTurn);
    }
    this.emit({
      type: "session.permission",
      sessionId: this.id,
      request: {
        id,
        name: `omp.${request.method}`,
        kind: "question",
        title: header,
        ...(request.method === "confirm"
          ? { description: this.dataFilter.text(request.message, 64 * 1024) }
          : {}),
        input: {
          questions: [
            {
              header,
              question: this.dataFilter.text(
                request.method === "confirm" ? request.message : request.title,
                64 * 1024,
              ),
              options: questionOptions,
              multiSelect: false,
              ...(freeformSentinel ? { allowOther: true } : {}),
              ...(request.method === "input" && request.placeholder
                ? { placeholder: this.dataFilter.text(request.placeholder, 4_096) }
                : {}),
              ...((request.method === "input" || request.method === "editor") && request.prefill
                ? { prefill: this.dataFilter.text(request.prefill) }
                : {}),
            },
          ],
        },
        actions,
      },
    });
  }

  private rejectPermissionRequest(request: OmpQuestionRequest, description: string): void {
    this.emit({
      type: "session.notice",
      sessionId: this.id,
      notice: {
        id: `omp:permission-rejected:${this.permissionSequence + 1}`,
        severity: "warning",
        title: "OMP question canceled",
        description,
      },
    });
    void this.runtime
      .respondToExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true })
      .catch(() => this.handleRuntimeFailure());
  }

  private freeformSelection(
    pending: PendingPermission,
    response: ProviderPermissionResponse,
  ): string | undefined {
    if (
      pending.request.method !== "select" ||
      !pending.freeformSentinel ||
      response.behavior !== "allow" ||
      response.selectedActionId !== undefined
    ) {
      return;
    }
    const answers = response.updatedInput?.answers;
    const answer =
      answers && typeof answers === "object" && !Array.isArray(answers)
        ? answers[pending.header]
        : undefined;
    const value = Array.isArray(answer) ? answer[0] : answer;
    if (
      typeof value !== "string" ||
      pending.optionValues.has(value) ||
      pending.displayValues.has(value)
    ) {
      return;
    }
    if (
      value === pending.freeformSentinel ||
      value.trim().length === 0 ||
      value.includes("\0") ||
      utf8Bytes(value) > MAX_FREEFORM_RESPONSE_BYTES
    ) {
      throw new OmpPublicError("OMP freeform response is invalid");
    }
    return value;
  }

  private extensionUiResponse(
    pending: PendingPermission,
    response: ProviderPermissionResponse,
  ): OmpExtensionUiResponse {
    if (response.selectedActionId !== undefined) {
      const expectedBehavior = pending.actionBehaviors.get(response.selectedActionId);
      if (expectedBehavior === undefined || expectedBehavior !== response.behavior) {
        throw new OmpPublicError("OMP permission action is invalid");
      }
    }
    const { nativeId, request, header } = pending;
    if (request.method === "confirm") {
      if (response.behavior === "deny") {
        return { type: "extension_ui_response", id: nativeId, confirmed: false };
      }
      const answers = response.updatedInput?.answers;
      const answer =
        answers && typeof answers === "object" && !Array.isArray(answers)
          ? answers[header]
          : undefined;
      return {
        type: "extension_ui_response",
        id: nativeId,
        confirmed: typeof answer === "string" ? /^yes$/iu.test(answer.trim()) : true,
      };
    }
    this.reevaluateDeferredPermissionTerminal();
    if (response.behavior === "deny") {
      return { type: "extension_ui_response", id: nativeId, cancelled: true };
    }
    const selectedValue = response.selectedActionId
      ? pending.optionValues.get(response.selectedActionId)
      : undefined;
    if (selectedValue !== undefined) {
      return { type: "extension_ui_response", id: nativeId, value: selectedValue };
    }
    const answers = response.updatedInput?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new OmpPublicError("OMP question response requires answers");
    }
    const answer = answers[header];
    const publicValue = Array.isArray(answer) ? answer[0] : answer;
    if (typeof publicValue !== "string") {
      throw new OmpPublicError("OMP question response is invalid");
    }
    if (
      request.method === "select" &&
      pending.freeformSentinel &&
      publicValue !== pending.freeformSentinel &&
      !pending.displayValues.has(publicValue) &&
      !pending.optionValues.has(publicValue)
    ) {
      if (
        publicValue.trim().length === 0 ||
        publicValue.includes("\0") ||
        utf8Bytes(publicValue) > MAX_FREEFORM_RESPONSE_BYTES
      ) {
        throw new OmpPublicError("OMP freeform response is invalid");
      }
      this.pendingFreeformSelection = {
        value: publicValue,
        nativeSelectId: pending.nativeId,
        generation: pending.generation,
        runtime: pending.runtime,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      };
      return {
        type: "extension_ui_response",
        id: nativeId,
        value: pending.freeformSentinel,
      };
    }
    if (request.method === "select") {
      const mapped =
        pending.optionValues.get(publicValue) ?? pending.displayValues.get(publicValue);
      if (mapped === undefined) {
        throw new OmpPublicError("OMP selection response is invalid");
      }
      return { type: "extension_ui_response", id: nativeId, value: mapped };
    }
    return { type: "extension_ui_response", id: nativeId, value: publicValue };
  }

  resolvePermissionByNativeId(nativeId: string): void {
    for (const permissions of [this.pendingPermissions, this.inFlightPermissions]) {
      for (const [permissionId, pending] of permissions) {
        if (pending.nativeId !== nativeId) continue;
        permissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
        this.reevaluateDeferredPermissionTerminal();
        return;
      }
    }
  }

  resolveTurnPermissions(turnId: string): void {
    if (this.pendingFreeformSelection?.turnId === turnId) this.pendingFreeformSelection = null;
    this.resolvePermissions((pending) => pending.turnId === turnId, true);
    this.resolveToolPermissions((pending) => pending.turnId === turnId, true);
  }
  resolveAllPermissions(cancelNative = false): void {
    this.pendingFreeformSelection = null;
    this.resolvePermissions(() => true, cancelNative);
    this.resolveToolPermissions(() => true, cancelNative);
  }

  private resolvePermissions(
    matches: (pending: PendingPermission) => boolean,
    cancelNative: boolean,
  ): void {
    const permissionIds = new Set<string>();
    for (const permissions of [this.pendingPermissions, this.inFlightPermissions]) {
      for (const [permissionId, pending] of permissions) {
        if (!matches(pending)) continue;
        permissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        permissionIds.add(permissionId);
        if (cancelNative && permissions === this.pendingPermissions) {
          void pending.runtime
            .respondToExtensionUi({
              type: "extension_ui_response",
              id: pending.nativeId,
              cancelled: true,
            })
            .catch(() => {
              if (!this.closed && !this.runtimeDead) {
                this.invalidateRuntime("OMP permission cancellation failed");
              }
            });
        }
      }
    }
    for (const permissionId of permissionIds) {
      this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
    }
    this.reevaluateDeferredPermissionTerminal();
  }
  private resolveToolPermissions(
    matches: (pending: PendingToolPermission) => boolean,
    cancelNative: boolean,
  ): void {
    const permissionIds = new Set<string>();
    for (const permissions of [this.pendingToolPermissions, this.inFlightToolPermissions]) {
      for (const [permissionId, pending] of permissions) {
        if (!matches(pending)) continue;
        permissions.delete(permissionId);
        if (pending.timer !== undefined) this.scheduler.clear(pending.timer);
        this.resolvedToolApprovalIds.add(pending.nativeId);
        permissionIds.add(permissionId);
        if (cancelNative && permissions === this.pendingToolPermissions) {
          void pending.runtime
            .respondToToolApproval({
              type: "tool_approval_response",
              id: pending.nativeId,
              toolCallId: pending.toolCallId,
              cancelled: true,
            })
            .catch(() => {
              if (!this.closed && !this.runtimeDead) {
                this.invalidateRuntime("OMP tool permission cancellation failed");
              }
            });
        }
      }
    }
    for (const permissionId of permissionIds) {
      this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
    }
    this.reevaluateDeferredPermissionTerminal();
  }

  private armToolPermissionTimeout(permissionId: string, pending: PendingToolPermission): void {
    if (pending.expiresAt === undefined) return;
    const remainingMs = Math.max(0, pending.expiresAt - Date.now());
    pending.timer = this.scheduler.set(() => {
      if (this.pendingToolPermissions.get(permissionId) !== pending) return;
      this.pendingToolPermissions.delete(permissionId);
      this.inFlightToolPermissions.set(permissionId, pending);
      void pending.runtime
        .respondToToolApproval({
          type: "tool_approval_response",
          id: pending.nativeId,
          toolCallId: pending.toolCallId,
          cancelled: true,
          timedOut: true,
        })
        .then(
          () => {
            if (this.inFlightToolPermissions.get(permissionId) !== pending) return;
            this.inFlightToolPermissions.delete(permissionId);
            this.resolvedToolApprovalIds.add(pending.nativeId);
            this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
            this.reevaluateDeferredPermissionTerminal();
          },
          () => this.handleRuntimeFailure(),
        );
    }, remainingMs);
  }

  private armPermissionTimeout(permissionId: string, pending: PendingPermission): void {
    if (pending.expiresAt === undefined) return;
    const remainingMs = Math.max(0, pending.expiresAt - Date.now());
    pending.timer = this.scheduler.set(() => {
      if (this.pendingPermissions.get(permissionId) !== pending) return;
      this.pendingPermissions.delete(permissionId);
      if (!this.permissionOwnerIsCurrent(pending)) {
        this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
        this.reevaluateDeferredPermissionTerminal();
        return;
      }
      this.inFlightPermissions.set(permissionId, pending);
      void pending.runtime
        .respondToExtensionUi({
          type: "extension_ui_response",
          id: pending.nativeId,
          cancelled: true,
          timedOut: true,
        })
        .then(
          () => {
            if (this.inFlightPermissions.get(permissionId) !== pending) return;
            this.inFlightPermissions.delete(permissionId);
            this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId });
            this.reevaluateDeferredPermissionTerminal();
          },
          () => this.handleRuntimeFailure(),
        );
    }, remainingMs);
  }

  private permissionOwnerIsCurrent(pending: PendingPermission | PendingToolPermission): boolean {
    if (
      this.closed ||
      this.runtimeDead ||
      pending.generation !== this.generation ||
      pending.runtime !== this.runtime
    ) {
      return false;
    }
    if (pending.turnId === undefined) return true;
    return this.activeTurn?.turnId === pending.turnId && !this.activeTurn.terminal;
  }

  hasForTurn(turnId: string): boolean {
    const ownsTurn = (pending: PendingPermission | PendingToolPermission) =>
      pending.turnId === turnId;
    return (
      [...this.pendingPermissions.values()].some(ownsTurn) ||
      [...this.inFlightPermissions.values()].some(ownsTurn) ||
      [...this.pendingToolPermissions.values()].some(ownsTurn) ||
      [...this.inFlightToolPermissions.values()].some(ownsTurn)
    );
  }

  clearPendingFreeformSelection(nativeId?: string): void {
    if (nativeId === undefined || this.pendingFreeformSelection?.nativeSelectId === nativeId) {
      this.pendingFreeformSelection = null;
    }
  }
}
