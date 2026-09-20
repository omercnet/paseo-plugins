import { describe, expect, test } from "vitest";
import type { OmpRpcEvent } from "../server/provider/omp-rpc-protocol";
import { FakeRpcChild, observeCommands, READY_FRAME, runtimeFor } from "./helpers/omp-rpc-harness";

describe("OMP RPC transport", () => {
  test("writes extension UI responses without waiting for an RPC response", async () => {
    const child = new FakeRpcChild();
    const commands: Record<string, unknown>[] = [];
    observeCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        child.write({
          type: "response",
          id: command.id,
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        });
      }
      if (command.type === "get_available_commands") {
        child.write({
          type: "response",
          id: command.id,
          command: "get_available_commands",
          success: true,
          data: {
            commands: [{ name: "help", description: "Help", input: null, source: "builtin" }],
          },
        });
      }
    });
    const opening = runtimeFor(child).startSession({ cwd: "/repo", mode: "full" });
    child.write(READY_FRAME);
    const session = await opening;
    const received: OmpRpcEvent[] = [];
    session.onEvent((event) => received.push(event));
    child.write({
      type: "extension_ui_request",
      id: "ui-select",
      method: "select",
      title: "Target",
      options: ["Preview", "Production"],
      optionDetails: [{ description: "Safe" }, { description: "Live" }],
    });
    child.write({
      type: "auto_compaction_start",
      reason: "threshold",
      action: "context-full",
    });
    await Promise.resolve();
    expect(received).toEqual([
      {
        type: "extension_ui_request",
        id: "ui-select",
        method: "select",
        title: "Target",
        options: ["Preview", "Production"],
        optionDetails: [{ description: "Safe" }, { description: "Live" }],
      },
      {
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      },
    ]);
    child.write({ type: "compaction_start" });
    child.write({
      type: "compaction_end",
      aborted: false,
      willRetry: false,
      skipped: true,
    });
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "bad-image",
        content: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
      },
      assistantMessageEvent: {
        type: "metadata",
        contentIndex: 0,
        content: { type: "image", data: "not-base64", mimeType: "image/png" },
      },
    });
    const encodedSecret = Buffer.from("arbitrary secret bytes").toString("base64");
    child.write({
      type: "message_update",
      message: {
        role: "assistant",
        responseId: "secret-image",
        content: [{ type: "image", data: encodedSecret, mimeType: "image/png" }],
      },
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 0,
        content: { type: "image", data: encodedSecret, mimeType: "image/png" },
      },
    });
    await Promise.resolve();
    expect(received).toContainEqual({ type: "compaction_start" });
    expect(received).toContainEqual({
      type: "compaction_end",
      aborted: false,
      willRetry: false,
      skipped: true,
    });
    expect(received.some((event) => event.type === "message_update")).toBe(false);
    await expect(session.getAvailableCommands()).resolves.toEqual([
      { name: "help", description: "Help", input: null, source: "builtin" },
    ]);

    await session.respondToExtensionUi({
      type: "extension_ui_response",
      id: "ui-select",
      value: "Production",
    });
    expect(commands).toContainEqual({
      type: "extension_ui_response",
      id: "ui-select",
      value: "Production",
    });
    await session.close();
  });

  test("bounds stalled one-way writes and rejects them on close", async () => {
    const start = async (timeoutMs: number) => {
      const child = new FakeRpcChild();
      observeCommands(child, (command) => {
        if (command.type === "negotiate_protocol") {
          child.write({
            type: "response",
            id: command.id,
            command: "negotiate_protocol",
            success: true,
            data: { protocolVersion: 2 },
          });
        }
      });
      const opening = runtimeFor(child, [], timeoutMs).startSession({ cwd: "/repo", mode: "full" });
      child.write(READY_FRAME);
      const session = await opening;
      Object.defineProperty(child.stdin, "write", { value: () => true });
      return { child, session };
    };

    const timed = await start(10);
    await expect(
      timed.session.respondToExtensionUi({
        type: "extension_ui_response",
        id: "timed",
        value: "answer",
      }),
    ).rejects.toThrow("OMP RPC write timed out");
    await timed.session.close();

    const closing = await start(10_000);
    const pending = closing.session.respondToExtensionUi({
      type: "extension_ui_response",
      id: "closing",
      value: "answer",
    });
    await closing.session.close();
    await expect(pending).rejects.toThrow("OMP RPC process was closed");

    const saturated = await start(10_000);
    const pendingWrites = Array.from({ length: 256 }, (_, index) =>
      saturated.session.respondToExtensionUi({
        type: "extension_ui_response",
        id: `pending-${index}`,
        value: "answer",
      }),
    );
    const settledWrites = Promise.allSettled(pendingWrites);
    await expect(
      saturated.session.respondToExtensionUi({
        type: "extension_ui_response",
        id: "overflow",
        value: "answer",
      }),
    ).rejects.toThrow("OMP RPC has too many pending writes");
    await saturated.session.close();
    expect((await settledWrites).every((result) => result.status === "rejected")).toBe(true);
  });
});
