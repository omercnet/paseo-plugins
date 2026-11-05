import { type PluginTimelineItemProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { type OmpGeneratedImages, resolveOmpGeneratedImages } from "../shared/generated-image";
import type { OmpImage } from "../shared/provider-image";
import { OmpImageTimeline, useOmpImageSource } from "./provider-image";
import { canDownloadFiles, downloadDataUri } from "./web";

const LABEL = "Generated image";

function DownloadButton({
  image,
  hostId,
  color,
}: {
  image: OmpImage;
  hostId: string;
  color: string;
}) {
  const source = useOmpImageSource(image, hostId);
  if (source.status !== "ready") return null;
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Download generated image"
      onPress={() => downloadDataUri(source.uri, `generated-image-${image.id}.${extension}`)}
    >
      <Text style={{ color, fontSize: 12, fontWeight: "600" }}>Download</Text>
    </Pressable>
  );
}

export function OmpGeneratedImagesRow(props: PluginTimelineItemProps<OmpGeneratedImages>) {
  const { item, theme, host } = props;
  const resolve = useRpc(resolveOmpGeneratedImages);
  const query = useQuery({
    queryKey: ["omp-generated-images", host.id, item.data.paths],
    queryFn: () => resolve({ paths: item.data.paths }),
    staleTime: (current) =>
      current.state.data?.images.every((result) => result.status === "available")
        ? Number.POSITIVE_INFINITY
        : 0,
    retry: 1,
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (query.isError)
    return <Text style={muted}>Unable to load generated images from the host.</Text>;
  if (!query.data) return <Text style={muted}>Loading image...</Text>;
  const images: OmpImage[] = [];
  for (const result of query.data.images) {
    if (result.status === "available") {
      images.push({ id: result.ref.slice(0, 16), ref: result.ref, mimeType: result.mimeType });
    }
  }
  return (
    <View style={{ gap: 8 }}>
      {images.length > 0 ? (
        <OmpImageTimeline
          {...props}
          item={{ ...item, kind: "omp-images", data: { label: LABEL, images } }}
        />
      ) : null}
      {canDownloadFiles
        ? images.map((image, index) => (
            <DownloadButton
              key={`${index}:${image.id}`}
              image={image}
              hostId={host.id}
              color={theme.colors.accent}
            />
          ))
        : null}
      {images.length < query.data.images.length ? (
        <Text style={muted}>Some generated images are no longer available on the host.</Text>
      ) : null}
    </View>
  );
}
