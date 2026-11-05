import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { listOmpSecurity, type OmpSecurityScan } from "../shared/omp-security";
import type { OmpStore } from "../shared/omp-store";
import type { OmpConfigStyles } from "./omp-config-styles";
import { severityText } from "./omp-security-state";
import { ompStoreKey } from "./omp-store-state";

const INFO =
  "Scans the agent ran with OMP's security_scan tool for this project, read through omp itself. Only each scan's phase and finding counts are shown: findings are private, so titles, locations and reports stay in OMP. Starting, cancelling or validating a scan happens inside an agent session; ask the agent. Opening this tab makes OMP create an empty store entry for the project.";

/** A refetch runs up to 22 omp processes, so it is manual or at most once a minute. */
const STALE_MS = 60_000;

function rowLabel(scan: OmpSecurityScan): string {
  const noun = scan.findingCount === 1 ? "finding" : "findings";
  return `${scan.phase} · ${scan.findingCount} ${noun}`;
}

export function OmpSecuritySection({
  styles,
  cwd,
  store,
}: {
  styles: OmpConfigStyles;
  cwd: string;
  store?: OmpStore;
}) {
  const load = useRpc(listOmpSecurity);
  const security = useQuery({
    queryKey: ["paseo-omp", "security", ompStoreKey(store), cwd],
    queryFn: () => load({ store, cwd }),
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
  });
  const list = security.data;
  return (
    <View style={{ gap: 12 }}>
      <SettingsSection title="Security scans" info={INFO}>
        <SettingsCard>
          <SettingsAction
            label="Refresh list"
            hint="Read the scans from omp again"
            actionLabel={security.isFetching ? "Refreshing..." : "Refresh"}
            disabled={security.isFetching}
            onPress={() => void security.refetch()}
          />
        </SettingsCard>
      </SettingsSection>
      {security.isLoading ? <Text style={styles.muted}>Loading security scans...</Text> : null}
      {security.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not read OMP's security scans.
        </Text>
      ) : null}
      {list?.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {list.message}
        </Text>
      ) : null}
      {list?.status === "off" ? (
        <Text style={styles.muted}>
          Security scans are off. Turn on security.enabled in the Configuration tab to use them.
        </Text>
      ) : null}
      {list?.status === "ready" && list.scans.length === 0 ? (
        <Text style={styles.muted}>No scans are stored for this project</Text>
      ) : null}
      {list?.status === "ready" && list.skipped > 0 ? (
        <Text style={styles.muted}>
          {`${list.skipped} ${list.skipped === 1 ? "entry" : "entries"} in OMP's scan list could not be read`}
        </Text>
      ) : null}
      {list?.status === "ready" && list.scans.length > 0 ? (
        <SettingsSection title="Scans">
          <SettingsCard>
            {list.scans.map((scan) => (
              <SettingsRow
                key={scan.id}
                label={rowLabel(scan)}
                hint={`${severityText(scan)} · ${scan.producer} · ${scan.createdAt}`}
              />
            ))}
          </SettingsCard>
          {list.truncated ? (
            <Text style={styles.muted}>Only the first scans OMP lists are shown</Text>
          ) : null}
        </SettingsSection>
      ) : null}
    </View>
  );
}
