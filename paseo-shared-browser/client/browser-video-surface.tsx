/** Platform renderer boundary. Android retains decoded frames in the host canvas,
 * while the existing decoder owns source, epoch, geometry and queue admission. */
import * as Host from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef } from "react";
import { Platform, type StyleProp, View, type ViewStyle } from "react-native";
import type { BrowserVideoCodec, BrowserVideoDecodeEnvironment } from "./browser-video-decoder";
import * as Web from "./web";

interface NativeNode {
  native: true;
  handle: Host.EncodedVideoHandle;
  callbacks: Parameters<BrowserVideoDecodeEnvironment["createDecoder"]>[0] | null;
  queueSize: number;
  generation: number;
}
export type BrowserVideoCanvasNode = Web.BrowserVideoCanvasNode | NativeNode;

/** Old native clients retain screenshots until they install the new host SDK. */
export function supportsBrowserVideo() {
  if (Platform.OS === "web") return Web.supportsBrowserVideo();
  // COMPAT(pluginEncodedVideo): added in v0.11.0, remove after 2027-04-04
  return Platform.OS === "android" && typeof Host.EncodedVideo !== "undefined";
}

/** Native lifecycle is owned by AppState and the surrounding panel. */
export function bindBrowserVideoVisibility(
  node: BrowserVideoCanvasNode,
  active: (value: boolean) => void,
) {
  if ("native" in node) {
    active(true);
    return () => {};
  }
  return Web.bindBrowserVideoVisibility(node, active);
}

/** Adapt the host's asynchronous decoder without changing packet authority policy. */
export function createBrowserVideoEnvironment(
  node: BrowserVideoCanvasNode,
  beforeDraw: () => void,
) {
  if (!("native" in node)) return Web.createBrowserVideoEnvironment(node);
  const environment: BrowserVideoDecodeEnvironment = {
    createDecoder(callbacks) {
      node.generation += 1;
      const generation = node.generation;
      node.callbacks = callbacks;
      node.queueSize = 0;
      return {
        get decodeQueueSize() {
          return node.queueSize;
        },
        configure(config) {
          const { description, ...settings } = config;
          node.handle.configure({
            ...settings,
            ...(description ? { descriptionBase64: encodeBytes(description) } : {}),
          });
        },
        decode(chunk) {
          node.queueSize += 1;
          if (
            !chunk ||
            typeof chunk !== "object" ||
            !("type" in chunk) ||
            (chunk.type !== "key" && chunk.type !== "delta") ||
            !("timestamp" in chunk) ||
            typeof chunk.timestamp !== "number" ||
            !("dataBase64" in chunk) ||
            typeof chunk.dataBase64 !== "string"
          )
            throw new Error("Invalid native video chunk");
          node.handle.decode({
            type: chunk.type,
            timestamp: chunk.timestamp,
            dataBase64: chunk.dataBase64,
          });
        },
        close() {
          if (generation !== node.generation) return;
          node.callbacks = null;
          node.queueSize = 0;
          node.handle.reset();
        },
      } satisfies BrowserVideoCodec;
    },
    createEncodedChunk: (input) => input,
    createChunk(input) {
      return { type: input.type, timestamp: input.timestamp, dataBase64: encodeBytes(input.data) };
    },
    decodeBase64(data) {
      const binary = atob(data);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    },
    scheduleDraw(draw) {
      const timer = setTimeout(draw, 0);
      return () => clearTimeout(timer);
    },
    async draw(frame) {
      beforeDraw();
      if (!("id" in frame) || typeof frame.id !== "number")
        throw new Error("Native video frame has no retained ID");
      await node.handle.present(frame.id);
    },
  };
  return {
    environment,
    dispose() {
      node.callbacks = null;
      node.handle.reset();
    },
  };
}

/** Encode only at the bridge boundary; stream reads remain authenticated Paseo RPCs. */
function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

interface SurfaceProps {
  canvasRef(value: unknown): void;
  onError(error: unknown): void;
  style: StyleProp<ViewStyle>;
}

/** Pointer handling stays on the sibling native touch overlay, never inside the WebView. */
export function BrowserVideoSurface({ canvasRef, onError, style }: SurfaceProps) {
  const handle = useRef<Host.EncodedVideoHandle>(null);
  const node = useRef<NativeNode | null>(null);
  useEffect(
    () => () => {
      canvasRef(null);
      node.current = null;
    },
    [canvasRef],
  );
  if (Platform.OS === "web")
    return <View ref={canvasRef} style={style} pointerEvents="none" accessible={false} />;
  if (!supportsBrowserVideo()) return null;
  return (
    <View style={style} pointerEvents="none" accessible={false}>
      <Host.EncodedVideo
        ref={handle}
        style={{ flex: 1 }}
        onReady={() => {
          if (!handle.current) return;
          node.current = {
            native: true,
            handle: handle.current,
            callbacks: null,
            queueSize: 0,
            generation: 0,
          };
          canvasRef(node.current);
        }}
        onFrame={(frame) => {
          const target = node.current;
          const generation = target?.generation;
          target?.callbacks?.output({
            ...frame,
            close() {
              if (target.generation === generation) target.handle.release(frame.id);
            },
          });
        }}
        onDequeue={() => {
          if (!node.current) return;
          node.current.queueSize = Math.max(0, node.current.queueSize - 1);
          node.current.callbacks?.dequeue();
        }}
        onError={(error) => {
          node.current?.callbacks?.error(error);
          onError(error);
        }}
      />
    </View>
  );
}
