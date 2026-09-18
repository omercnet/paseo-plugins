import type {
  PluginHandlerContext,
  PluginServerContext,
  PluginSettings,
} from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import contribute, { resolveRegisteredGasCitySettings } from "../index.server";
import { dispatchWork, GasCitySettingsSchema, type gasCitySettings } from "../shared";
import { dispatchRequestFixture } from "./fixtures";

type RegisteredHandler = (input: unknown, context: PluginHandlerContext) => Promise<unknown>;

function registeredDispatch(settings: unknown): RegisteredHandler {
  const handlers = new Map<string, RegisteredHandler>();
  contribute({
    registerSettings: () => settings,
    handle(contract, handler) {
      handlers.set(contract.name, handler as RegisteredHandler);
    },
    registerProvider() {},
  } as unknown as PluginServerContext);

  const handler = handlers.get(dispatchWork.name);
  if (!handler) throw new Error("Dispatch handler was not registered");
  return handler;
}

const handlerContext = { paseo: {} } as PluginHandlerContext;

afterEach(() => vi.unstubAllGlobals());

describe("server settings runtime compatibility", () => {
  test("uses fail-closed schema defaults when Paseo 0.8 registerSettings returns void", async () => {
    const settings = resolveRegisteredGasCitySettings(undefined);
    await expect(settings.read()).resolves.toEqual({
      status: "ready",
      revision: "paseo-0.8-schema-defaults",
      values: GasCitySettingsSchema.parse({}),
    });

    await expect(
      registeredDispatch(undefined)({ request: dispatchRequestFixture }, handlerContext),
    ).rejects.toThrow("interactive safety interlock");
  });

  test("preserves the Paseo 0.9 persisted settings handle", async () => {
    const values = GasCitySettingsSchema.parse({ mutationsEnabled: true });
    const unsubscribe = vi.fn();
    const registered = {
      read: vi.fn(async () => ({ status: "ready" as const, revision: "persisted", values })),
      subscribe: vi.fn(() => unsubscribe),
    } satisfies PluginSettings<typeof gasCitySettings.schema>;
    const resolved = resolveRegisteredGasCitySettings(registered);
    const listener = vi.fn();

    expect(resolved).toBe(registered);
    expect(resolved.subscribe(listener)).toBe(unsubscribe);

    const fetch = vi.fn(async () =>
      Response.json({ status: "slung", target: "alpha/reviewer", bead: "al-1", warnings: [] }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      registeredDispatch(registered)({ request: dispatchRequestFixture }, handlerContext),
    ).resolves.toMatchObject({ status: "slung", beadId: "al-1" });
    expect(registered.read).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("fails closed when Paseo 0.9 persisted settings are invalid", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const registered = {
      read: async () => ({ status: "invalid" as const, revision: "broken", error: "corrupt" }),
      subscribe: () => () => {},
    } satisfies PluginSettings<typeof gasCitySettings.schema>;

    await expect(
      registeredDispatch(registered)({ request: dispatchRequestFixture }, handlerContext),
    ).rejects.toThrow("Gas City settings are invalid: corrupt");
    expect(fetch).not.toHaveBeenCalled();
  });
});

test("does not register a native session provider for Gas City v1.4.1", () => {
  let registrations = 0;

  contribute({
    registerSettings() {
      return resolveRegisteredGasCitySettings(undefined);
    },
    handle() {},
    registerProvider() {
      registrations += 1;
    },
  } as unknown as PluginServerContext);

  expect(registrations).toBe(0);
});
