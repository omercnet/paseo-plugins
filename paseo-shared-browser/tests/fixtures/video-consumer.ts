/** Owned real-browser consumer, built for the opt-in video smoke test only. */

import { createBrowserVideoDecoder } from "../../client/browser-video-decoder";
import { type BrowserVideoCanvasNode, createBrowserVideoEnvironment } from "../../client/web";
import type { BrowserState } from "../../shared/browser";
import type { BrowserVideoPacket, BrowserVideoReadReply } from "../../shared/browser-video";

interface ReadbackCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): {
    getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
  };
}
declare const document: {
  getElementById(id: string): unknown;
  querySelector(query: string): ReadbackCanvas | null;
};
interface Presentation {
  frameId: string;
  width: number;
  height: number;
  corners: number[][];
  sourceToDrawMs: number;
}
interface FixtureGlobals {
  presented: Presentation[];
  failures: string[];
  needsKey: boolean;
  prepareVideo(state: BrowserState): void;
  consumeVideo(reply: BrowserVideoReadReply): void;
  finishVideo(): void;
}
const fixture = globalThis as unknown as FixtureGlobals;
let decoder: ReturnType<typeof createBrowserVideoDecoder> | null = null;
let environment: ReturnType<typeof createBrowserVideoEnvironment> = null;
let state: BrowserState | null = null;
let epoch = 0;
fixture.prepareVideo = (nextState) => {
  decoder?.close();
  environment?.dispose();
  state = nextState;
  epoch++;
  fixture.presented = [];
  fixture.failures = [];
  fixture.needsKey = false;
  environment = createBrowserVideoEnvironment(
    document.getElementById("video") as BrowserVideoCanvasNode,
  );
  if (!environment) throw new Error("Web video adapter unavailable");
  decoder = createBrowserVideoDecoder({
    environment: environment.environment,
    isCurrent: (packet: BrowserVideoPacket, packetEpoch: number) =>
      packetEpoch === epoch &&
      Boolean(state) &&
      packet.frame.sessionId === state!.sessionId &&
      packet.frame.runtimeId === state!.runtimeId &&
      packet.frame.captureEpoch === state!.bridgeEpoch &&
      packet.frame.navigationGeneration === state!.navigationGeneration &&
      packet.frame.viewportGeneration === state!.viewportGeneration,
    onPresented: (packet) => {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("Video canvas missing");
      const context = canvas.getContext("2d");
      const corners = [
        [5, 5],
        [canvas.width - 6, 5],
        [5, canvas.height - 6],
        [canvas.width - 6, canvas.height - 6],
      ].map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data).slice(0, 3));
      fixture.presented.push({
        frameId: packet.frame.frameId,
        width: canvas.width,
        height: canvas.height,
        corners,
        sourceToDrawMs: Date.now() - Date.parse(packet.capturedAt),
      });
    },
    onNeedKeyFrame: () => {
      fixture.needsKey = true;
    },
    onError: (error) => {
      fixture.failures.push(String(error));
    },
  });
};
fixture.consumeVideo = (reply) => {
  if (reply.status === "reset") fixture.prepareVideo(reply.state);
  state = reply.state;
  for (const packet of reply.packets) decoder?.receive(packet, epoch);
};
fixture.finishVideo = () => {
  decoder?.close();
  environment?.dispose();
};
