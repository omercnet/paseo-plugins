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
  details: z.unknown().optional(),
});

export type OmpImageTimelineData = z.infer<typeof ompImageTimelineSchema>;
