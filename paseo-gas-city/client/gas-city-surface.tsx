import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  discoverSupervisor,
  type GasCitySettings,
  gasCitySettings,
  toGasCityRpcSettings,
} from "../shared";
import { CityOperations } from "./city-operations";
import { selectAvailableCity } from "./view-model";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function GasCitySurface(props: PluginSurfaceProps) {
  const settings = useSettings(gasCitySettings);
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
  return <ReadyGasCitySurface key={settings.revision} {...props} settings={settings.values} />;
}

function ReadyGasCitySurface({
  theme,
  layout,
  host,
  navigation,
  settings,
}: PluginSurfaceProps & { settings: GasCitySettings }) {
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const rpcSettings = useMemo(() => toGasCityRpcSettings(settings), [settings]);
  const loadDiscovery = useRpc(discoverSupervisor);
  const discovery = useQuery({
    queryKey: ["gas-city", host.id, settings.endpointUrl, "discovery"],
    queryFn: () => loadDiscovery({ settings: rpcSettings }),
    refetchInterval: settings.refreshIntervalMs,
  });
  const retryDiscovery = () => void discovery.refetch();
  const [preferredCity, setPreferredCity] = useState<string | null>(null);

  if (discovery.isPending && !discovery.data) {
    return (
      <SurfaceState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        title="Finding Gas City"
        body="Contacting the configured supervisor."
        loading
      />
    );
  }
  if (discovery.error && !discovery.data) {
    return (
      <SurfaceState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        title="Could not reach Gas City"
        body={errorMessage(discovery.error)}
        onRetry={retryDiscovery}
      />
    );
  }
  if (!discovery.data) {
    return (
      <SurfaceState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        title="No supervisor data"
        body="The supervisor returned no usable discovery response."
        onRetry={retryDiscovery}
      />
    );
  }

  const data = discovery.data;
  const selectedCity = selectAvailableCity(preferredCity, data.cities);
  if (data.state !== "available" || !data.supervisor) {
    const diagnostic = data.diagnostics.map((item) => item.message).join(" ");
    return (
      <SurfaceState
        theme={theme}
        layout={layout}
        host={host}
        navigation={navigation}
        title={
          data.state === "not-configured" ? "Gas City is not configured" : "Gas City is unavailable"
        }
        body={
          diagnostic || `Supervisor state: ${data.state}. Check the endpoint in Gas City settings.`
        }
        onRetry={retryDiscovery}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.supervisorBar}>
        <View style={styles.supervisorTitleBlock}>
          <View style={styles.supervisorTitleRow}>
            <View style={[styles.statusDot, { backgroundColor: theme.colors.statusSuccess }]} />
            <Text accessibilityRole="header" style={styles.supervisorTitle}>
              Supervisor
            </Text>
          </View>
          <Text style={styles.supervisorMeta} numberOfLines={1}>
            {data.supervisor.endpointUrl} · {data.supervisor.runningCityCount}/
            {data.supervisor.cityCount} cities running
          </Text>
        </View>
        <View style={styles.versionBadge}>
          <Text style={styles.versionText}>{data.supervisor.version ?? "version unknown"}</Text>
        </View>
      </View>
      {data.diagnostics.length > 0 ? (
        <View accessibilityRole="alert" style={styles.discoveryDiagnostics}>
          <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
          <Text style={styles.discoveryDiagnosticText} numberOfLines={2}>
            {data.diagnostics.map((diagnostic) => diagnostic.message).join(" · ")}
          </Text>
        </View>
      ) : null}
      {data.cities.length > 0 ? (
        <ScrollView
          horizontal
          style={styles.cityRailScroller}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.cityRail}
        >
          {data.cities.map((city) => {
            const selected = selectedCity === city.name;
            return (
              <Pressable
                key={`${city.path}:${city.name}`}
                accessibilityRole="button"
                accessibilityLabel={`Show ${city.name} city operations`}
                accessibilityState={{ selected }}
                onPress={() => setPreferredCity(city.name)}
                style={({ pressed }) => [
                  styles.cityChip,
                  selected && styles.cityChipSelected,
                  pressed && styles.pressed,
                ]}
              >
                <View
                  style={[
                    styles.cityDot,
                    {
                      backgroundColor: city.running
                        ? theme.colors.statusSuccess
                        : theme.colors.statusWarning,
                    },
                  ]}
                />
                <Text style={[styles.cityChipText, selected && styles.cityChipTextSelected]}>
                  {city.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={styles.body}>
        {selectedCity ? (
          <CityOperations
            key={`${settings.endpointUrl}:${selectedCity}`}
            theme={theme}
            layout={layout}
            host={host}
            cityName={selectedCity}
            rigName={null}
            settings={settings}
          />
        ) : (
          <SurfaceState
            theme={theme}
            layout={layout}
            host={host}
            navigation={navigation}
            title="No cities discovered"
            body="The supervisor is available but has not reported a city."
            onRetry={retryDiscovery}
          />
        )}
      </View>
    </View>
  );
}

function SurfaceState({
  theme,
  title,
  body,
  loading,
  onRetry,
}: PluginSurfaceProps & { title: string; body: string; loading?: boolean; onRetry?: () => void }) {
  const styles = useMemo(() => createStyles(theme, true), [theme]);
  return (
    <View style={styles.stateScreen}>
      {loading ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <Icon name="Factory" size={28} color={theme.colors.foregroundMuted} />
      )}
      <Text accessibilityRole="header" style={styles.stateTitle}>
        {title}
      </Text>
      <Text style={styles.stateBody}>{body}</Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry Gas City"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(theme: PluginSurfaceProps["theme"], compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    supervisorBar: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingHorizontal: compact ? 12 : 18,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    supervisorTitleBlock: { flex: 1, minWidth: 0, gap: 3 },
    supervisorTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    supervisorTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "800" },
    supervisorMeta: { color: theme.colors.foregroundMuted, fontSize: 10 },
    versionBadge: {
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    versionText: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" },
    discoveryDiagnostics: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: compact ? 12 : 18,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    discoveryDiagnosticText: { flex: 1, color: theme.colors.statusWarning, fontSize: 10 },
    cityRailScroller: { flexGrow: 0 },
    cityRail: {
      gap: 6,
      paddingHorizontal: compact ? 12 : 18,
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    cityChip: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 9,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    cityChipSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
    cityDot: { width: 6, height: 6, borderRadius: 3 },
    cityChipText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    cityChipTextSelected: { color: theme.colors.foreground },
    body: { flex: 1 },
    stateScreen: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      padding: 24,
      backgroundColor: theme.colors.surface0,
    },
    stateTitle: {
      color: theme.colors.foreground,
      fontSize: 17,
      fontWeight: "800",
      textAlign: "center",
    },
    stateBody: {
      maxWidth: 480,
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      lineHeight: 18,
      textAlign: "center",
    },
    retryButton: {
      minHeight: 36,
      justifyContent: "center",
      paddingHorizontal: 13,
      borderRadius: 7,
      backgroundColor: theme.colors.accent,
    },
    retryText: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" },
    pressed: { opacity: 0.72 },
  });
}
