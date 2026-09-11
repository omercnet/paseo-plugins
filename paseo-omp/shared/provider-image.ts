import { z } from "zod";

export const ompImageTimelineSchema = z.object({
  label: z.string(),
  images: z
    .array(
      z.object({
        id: z.string(),
        data: z.string(),
        mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
      }),
    )
    .min(1)
    .max(64),
  text: z.string().optional(),
  details: z.json().optional(),
});

export const ompImageToolMetadataSchema = z.object({
  ompImage: ompImageTimelineSchema,
});

export function transformOmpImageToolItem(item: { callId: string; metadata?: unknown }) {
  const metadata = ompImageToolMetadataSchema.safeParse(item.metadata);
  if (!metadata.success) return undefined;
  return {
    items: [
      {
        type: "plugin" as const,
        kind: "omp-images",
        id: item.callId,
        version: 1,
        data: metadata.data.ompImage,
      },
    ],
  };
}

export type OmpImageTimelineData = z.infer<typeof ompImageTimelineSchema>;
