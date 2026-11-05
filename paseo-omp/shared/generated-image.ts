import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ompImageMimeTypeSchema, ompImageRefSchema } from "./provider-image";

export const OMP_GENERATED_IMAGE_KIND = "omp-generated-images";

const MAX_GENERATED_IMAGES = 8;
const MAX_PATH_LENGTH = 1024;
const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const pathsSchema = z.array(pathSchema).min(1).max(MAX_GENERATED_IMAGES);

/** Files OMP's `generate_image` tool saved on the daemon host; the row itself carries no usable bytes. */
export const ompGeneratedImagesSchema = z.object({ paths: pathsSchema });
export type OmpGeneratedImages = z.infer<typeof ompGeneratedImagesSchema>;

/** Copies each file into the image cache and returns its reference, so the stock image viewer can show it. */
export const resolveOmpGeneratedImages = defineRpc({
  name: "paseo-omp.resolve-generated-images",
  input: z.strictObject({ paths: pathsSchema }),
  output: z.object({
    images: z.array(
      z.discriminatedUnion("status", [
        z.object({
          status: z.literal("available"),
          ref: ompImageRefSchema,
          mimeType: ompImageMimeTypeSchema,
        }),
        z.object({ status: z.literal("missing") }),
      ]),
    ),
  }),
});

const generateImageRowSchema = z.object({
  name: z.literal("generate_image"),
  callId: z.string(),
  status: z.literal("completed"),
  detail: z.object({
    type: z.literal("unknown"),
    output: z.object({
      details: z.object({ imagePaths: z.array(z.string()) }).loose(),
    }),
  }),
});

/**
 * Replaces a completed built-in `generate_image` row with the images it saved. The provider cuts
 * the row's base64 at 64 KiB, but keeps `details.imagePaths`; a row without paths stays as is.
 */
export function transformOmpGeneratedImageItem(item: unknown) {
  const row = generateImageRowSchema.safeParse(item);
  if (!row.success) return undefined;
  const paths = row.data.detail.output.details.imagePaths
    .filter((path) => path.length > 0 && path.length <= MAX_PATH_LENGTH)
    .slice(0, MAX_GENERATED_IMAGES);
  if (paths.length === 0) return undefined;
  return {
    items: [
      {
        type: "plugin" as const,
        kind: OMP_GENERATED_IMAGE_KIND,
        id: row.data.callId,
        version: 1,
        data: { paths },
      },
    ],
  };
}
