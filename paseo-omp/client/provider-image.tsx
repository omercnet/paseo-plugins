import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import {
  getOmpImage,
  type OmpImage,
  type OmpImageTimelineData,
  ompImageRefetchInterval,
  ompImageStaleTime,
  visibleOmpImageText,
} from "../shared/provider-image";

type OmpImageSource =
  | { status: "loading" }
  | { status: "ready"; uri: string }
  | { status: "missing" }
  | { status: "failed" };

/** A decoded screenshot can hold several MB, so drop it soon after nothing shows it. */
const IMAGE_QUERY_GC_MS = 60_000;

function useOmpImageSource(image: OmpImage, hostId: string): OmpImageSource {
  const fetchImage = useRpc(getOmpImage);
  const ref = "ref" in image ? image.ref : null;
  const query = useQuery({
    queryKey: ["omp-image", hostId, ref, image.mimeType],
    queryFn: () => fetchImage({ ref: ref ?? "", mimeType: image.mimeType }),
    enabled: ref !== null,
    staleTime: (current) => ompImageStaleTime(current.state.data),
    refetchInterval: (current) =>
      ompImageRefetchInterval(
        current.state.data,
        // Failed rechecks keep the earlier "missing" data, so they count toward the limit too.
        current.state.dataUpdateCount + current.state.errorUpdateCount,
      ),
    gcTime: IMAGE_QUERY_GC_MS,
    retry: 1,
  });
  if ("data" in image)
    return { status: "ready", uri: `data:${image.mimeType};base64,${image.data}` };
  if (query.isError) return { status: "failed" };
  if (!query.data) return { status: "loading" };
  if (query.data.status === "missing") return { status: "missing" };
  return { status: "ready", uri: `data:${image.mimeType};base64,${query.data.data}` };
}

function unavailableImageText(source: OmpImageSource): string {
  if (source.status === "missing") return "This image is no longer available.";
  if (source.status === "failed") return "Unable to load this image from the host.";
  return "Loading image...";
}

type Theme = PluginTimelineItemProps<OmpImageTimelineData>["theme"];

function imageStyles(theme: Theme) {
  return {
    root: { gap: 8 },
    label: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    text: { color: theme.colors.foreground, fontSize: 13 },
    image: {
      width: "100%" as const,
      minHeight: 220,
      aspectRatio: 16 / 9,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
    imageFallback: {
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    imageFallbackText: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      textAlign: "center" as const,
    },
  };
}

type ImageStyles = ReturnType<typeof imageStyles>;

export function OmpImageTimeline({
  item,
  theme,
  host,
}: PluginTimelineItemProps<OmpImageTimelineData>) {
  const styles = useMemo(() => imageStyles(theme), [theme]);
  const [enlargedId, setEnlargedId] = useState<string | null>(null);
  const enlarged = item.data.images.find((image) => image.id === enlargedId);
  const [failedImageIds, setFailedImageIds] = useState<ReadonlySet<string>>(() => new Set());
  const visibleText = useMemo(() => visibleOmpImageText(item.data.text), [item.data.text]);
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{item.data.label}</Text>
      {visibleText ? <Text style={styles.text}>{visibleText}</Text> : null}
      {item.data.images.map((image, index) => (
        <OmpImageThumbnail
          key={image.id}
          image={image}
          hostId={host.id}
          label={`${item.data.label} image ${index + 1}`}
          failed={failedImageIds.has(image.id)}
          styles={styles}
          onEnlarge={() => setEnlargedId(image.id)}
          onRenderFailed={() =>
            setFailedImageIds((current) => {
              if (current.has(image.id)) return current;
              return new Set([...current, image.id]);
            })
          }
        />
      ))}
      <Modal
        title={item.data.label}
        open={enlarged !== undefined}
        onOpenChange={(open) => {
          if (!open) setEnlargedId(null);
        }}
      >
        <Modal.Content scrollable={false}>
          {enlarged ? (
            <EnlargedOmpImage
              key={enlarged.id}
              image={enlarged}
              hostId={host.id}
              failed={failedImageIds.has(enlarged.id)}
              label={item.data.label}
              theme={theme}
            />
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

function OmpImageThumbnail({
  image,
  hostId,
  label,
  failed,
  styles,
  onEnlarge,
  onRenderFailed,
}: {
  image: OmpImage;
  hostId: string;
  label: string;
  failed: boolean;
  styles: ImageStyles;
  onEnlarge: () => void;
  onRenderFailed: () => void;
}) {
  const source = useOmpImageSource(image, hostId);
  if (failed) {
    return (
      <View style={[styles.image, styles.imageFallback]}>
        <Text style={styles.imageFallbackText}>
          {image.mimeType.replace("image/", "").toUpperCase()} image could not be rendered on this
          Paseo client.
        </Text>
      </View>
    );
  }
  if (source.status !== "ready") {
    return (
      <View style={[styles.image, styles.imageFallback]}>
        <Text style={styles.imageFallbackText}>{unavailableImageText(source)}</Text>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Enlarge ${label}`}
      onPress={onEnlarge}
    >
      <Image
        source={{ uri: source.uri }}
        resizeMode="contain"
        accessibilityLabel={label}
        onError={onRenderFailed}
        style={styles.image}
      />
    </Pressable>
  );
}

function EnlargedOmpImage({
  image,
  hostId,
  label,
  failed,
  theme,
}: {
  image: OmpImage;
  hostId: string;
  label: string;
  failed: boolean;
  theme: Theme;
}) {
  const source = useOmpImageSource(image, hostId);
  if (source.status !== "ready") {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>
        {unavailableImageText(source)}
      </Text>
    );
  }
  return <EnlargedImage uri={source.uri} failed={failed} label={label} theme={theme} />;
}

/** Fits the image to the dialog; a tap shows it at its real pixel size, panned by scrolling. */
function EnlargedImage({
  uri,
  label,
  failed,
  theme,
}: {
  uri: string;
  failed: boolean;
  label: string;
  theme: Theme;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const [sizeUnavailable, setSizeUnavailable] = useState(false);
  useEffect(() => {
    let current = true;
    Image.getSize(
      uri,
      (width, height) => current && setNatural({ width, height }),
      () => current && setSizeUnavailable(true),
    );
    return () => {
      current = false;
    };
  }, [uri]);
  const canZoom = natural !== null;
  // The modal body is bounded (`scrollable={false}`), so the image and its scroller share its height
  // with the caption instead of guessing from the window.
  const fill = { flex: 1, minHeight: 0 };
  const mutedText = {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    textAlign: "center" as const,
  };
  if (failed || renderFailed) {
    return <Text style={mutedText}>This image could not be rendered on this Paseo client.</Text>;
  }
  return (
    <View style={[fill, { gap: 8 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          actualSize ? `Fit ${label} image to window` : `Show ${label} image at actual size`
        }
        disabled={!canZoom}
        onPress={() => setActualSize((value) => !value)}
        style={fill}
      >
        {actualSize && natural ? (
          <ScrollView style={fill}>
            <ScrollView horizontal>
              <Image
                source={{ uri }}
                accessibilityLabel={`${label} enlarged image`}
                onError={() => setRenderFailed(true)}
                style={{ width: natural.width, height: natural.height }}
              />
            </ScrollView>
          </ScrollView>
        ) : (
          <Image
            source={{ uri }}
            resizeMode="contain"
            accessibilityLabel={`${label} enlarged image`}
            onError={() => setRenderFailed(true)}
            style={[fill, { width: "100%" }]}
          />
        )}
      </Pressable>
      {canZoom ? (
        <Text style={mutedText}>
          {actualSize
            ? `${natural.width} × ${natural.height}px · tap to fit`
            : `Tap the image to see it at ${natural.width} × ${natural.height}px`}
        </Text>
      ) : null}
      {sizeUnavailable ? (
        <Text style={mutedText}>The actual size of this image is not available.</Text>
      ) : null}
    </View>
  );
}
