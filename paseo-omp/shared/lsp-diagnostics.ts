import { z } from "zod";

export const OMP_LSP_DIAGNOSTICS_KIND = "omp-lsp-diagnostics";

const severitySchema = z.enum(["error", "warning", "info", "hint"]);
export type OmpLspSeverity = z.infer<typeof severitySchema>;

export const ompLspDiagnosticsSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        diagnostics: z
          .array(
            z.object({
              line: z.number().int().positive(),
              column: z.number().int().positive(),
              severity: severitySchema,
              message: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type OmpLspDiagnostics = z.infer<typeof ompLspDiagnosticsSchema>;

const COUNTS =
  "\\d+ (?:error|warning|info|hint)\\(s\\)(?:, \\d+ (?:error|warning|info|hint)\\(s\\))*";
const HEADING = /^(#+) (.+)$/u;
const DIAGNOSTIC = /^\s+(\d+):(\d+) \[(error|warning|info|hint)\] (.+)$/u;
/** `3 error(s):` opens a single-target result. */
const TOTAL = new RegExp(`^${COUNTS}:$`, "u");
/** A glob result opens each file with `<icon> <path>: 1 error(s)` or `<icon> <path>: no issues`. */
const FILE_SUMMARY = new RegExp(`^\\S+ .+: (?:${COUNTS}|no issues)$`, "u");
/** OMP's own warnings (`<icon> a.ts: some servers failed (...)`, `[Showing lines ...]`) are not diagnostics. */
const NOTE =
  /^(?:\S+ .+: (?:no diagnostics report yet|some servers failed|all language servers failed)|\[.*\])/u;

/**
 * Parses the text of an OMP `lsp` diagnostics result: a headed tree (`# dir/`, `## file`) whose
 * files list `line:col [severity] message` rows. Returns `undefined` unless every file group is
 * recognized, so unknown output keeps its original row.
 */
export function parseOmpLspDiagnostics(text: string): OmpLspDiagnostics | undefined {
  const files = new Map<string, OmpLspDiagnostics["files"][number]["diagnostics"]>();
  const directories: string[] = [];
  let current: OmpLspDiagnostics["files"][number]["diagnostics"] | undefined;
  let summarized = false;
  let afterBlank = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }
    const wasAfterBlank = afterBlank;
    afterBlank = false;
    if (TOTAL.test(line) || FILE_SUMMARY.test(line)) {
      summarized = true;
      continue;
    }
    if (NOTE.test(line)) return undefined;
    const heading = HEADING.exec(line);
    if (heading) {
      const depth = (heading[1] ?? "").length - 1;
      const name = heading[2] ?? "";
      directories.length = depth;
      if (name.endsWith("/")) {
        directories[depth] = name;
        current = undefined;
        continue;
      }
      const path = directories.join("") + name;
      current = files.get(path) ?? [];
      files.set(path, current);
      continue;
    }
    const diagnostic = DIAGNOSTIC.exec(line);
    if (diagnostic && current) {
      current.push({
        line: Number(diagnostic[1]),
        column: Number(diagnostic[2]),
        severity: severitySchema.parse(diagnostic[3]),
        message: diagnostic[4] ?? "",
      });
      continue;
    }
    const last = current?.at(-1);
    if (!last || wasAfterBlank) return undefined;
    last.message += `\n${line.trim()}`;
  }
  if (!summarized) return undefined;
  const parsed = ompLspDiagnosticsSchema.safeParse({
    files: [...files].map(([path, diagnostics]) => ({ path, diagnostics })),
  });
  return parsed.success ? parsed.data : undefined;
}

const textBlockSchema = z.object({ type: z.string(), text: z.string().optional() }).loose();
const lspToolRowSchema = z.object({
  name: z.literal("lsp"),
  callId: z.string(),
  status: z.literal("completed"),
  detail: z.union([
    z.object({ type: z.literal("plain_text"), text: z.string() }),
    z.object({
      type: z.literal("unknown"),
      output: z.object({ content: z.array(textBlockSchema) }).loose(),
    }),
  ]),
});

/**
 * Replaces a completed built-in `lsp` tool row with a diagnostics card. The built-in provider keeps
 * only the result text (and raw JSON for an unmapped tool), so anything unparsable stays as is.
 */
export function transformOmpLspToolItem(item: unknown) {
  const row = lspToolRowSchema.safeParse(item);
  if (!row.success) return undefined;
  const { detail } = row.data;
  const text =
    detail.type === "plain_text"
      ? detail.text
      : detail.output.content
          .flatMap((block) => (block.text === undefined ? [] : [block.text]))
          .join("\n");
  const data = parseOmpLspDiagnostics(text);
  if (!data) return undefined;
  return {
    items: [
      {
        type: "plugin" as const,
        kind: OMP_LSP_DIAGNOSTICS_KIND,
        id: row.data.callId,
        version: 1,
        data,
      },
    ],
  };
}
