import { type PluginScreenProps, useSettings } from "@getpaseo/plugin/client";
import { gasCitySettings } from "../shared";
import { CityOperations } from "./city-operations";
import { SurfaceState } from "./gas-city-surface";
import { useDiscovery } from "./sidebar-item";
import { parseCityParam } from "./view-model";

export function CityScreen(props: PluginScreenProps) {
  const settings = useSettings(gasCitySettings);
  const discovery = useDiscovery(props.host.id);
  const city = parseCityParam(props.params);
  if (!city) {
    return (
      <SurfaceState
        {...props}
        title="No city selected"
        body="Open a city from the Gas City sidebar menu."
      />
    );
  }
  if (settings.status === "loading") {
    return (
      <SurfaceState
        {...props}
        title="Loading Gas City"
        body="Reading persisted connection settings."
        loading
      />
    );
  }
  if (settings.status !== "ready") {
    return (
      <SurfaceState
        {...props}
        title="Gas City settings unavailable"
        body={settings.error}
        onRetry={() => void settings.reload()}
      />
    );
  }
  const { health, data } = discovery;
  if (health.tone === "unavailable" || health.tone === "unconfigured") {
    return (
      <SurfaceState
        {...props}
        title={
          health.tone === "unconfigured" ? "Gas City is not configured" : "Gas City is unavailable"
        }
        body={health.summary}
        onRetry={discovery.refetch}
      />
    );
  }
  if (data?.state === "available" && !data.cities.some((item) => item.name === city)) {
    return (
      <SurfaceState
        {...props}
        title="City not found"
        body={`The supervisor does not report a city named ${city}.`}
        onRetry={discovery.refetch}
      />
    );
  }
  return (
    <CityOperations
      key={`${settings.revision}:${city}`}
      theme={props.theme}
      layout={props.layout}
      host={props.host}
      cityName={city}
      rigName={null}
      settings={settings.values}
    />
  );
}
