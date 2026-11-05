import { z } from "zod";

export const OMP_AST_EDIT_KIND = "omp-ast-edit";

export const ompAstEditSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        changes: z
          .array(
            z.object({
              line: z.number().int().positive(),
              before: z.string(),
              after: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});
export type OmpAstEdit = z.infer<typeof ompAstEditSchema>;

const PROPOSAL = /^Staged as a proposal\b/u;
const TAG = "#[0-9A-Fa-f]{2,8}";
/** `[a.ts#387A]` heads a single-file preview. */
const SINGLE_FILE = new RegExp(`^\\[(.+)${TAG}\\]$`, "u");
/** `## b.ts#D8CE (1 replacement)` is a file in a directory preview; `# sub/` is a directory. */
const TREE_FILE = new RegExp(`^(#+) (.+)${TAG} \\(\\d+ replacements?\\)$`, "u");
const TREE_DIRECTORY = /^(#+) (.+\/)$/u;
const CHANGE = /^([-+])(\d+):(.*)$/u;

type FileChanges = OmpAstEdit["files"][number]["changes"];

/**
 * Parses the preview text OMP's `ast_edit` returns in its default hashline mode: a header per file
 * (`[path#TAG]`, or a `#` tree for several files) followed by `-LINE:before` / `+LINE:after`
 * pairs. Returns `undefined` unless every line is recognized, so any other output (plain
 * line/column mode, no matches, parse issues, a truncation notice) keeps its original row.
 */
export function parseOmpAstEdit(text: string): OmpAstEdit | undefined {
  const files = new Map<string, FileChanges>();
  const directories: string[] = [];
  let current: FileChanges | undefined;
  let removed: { line: number; before: string } | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "" || PROPOSAL.test(line)) continue;
    const change = CHANGE.exec(line);
    if (change) {
      const number = Number(change[2]);
      const content = change[3] ?? "";
      if (!current) return undefined;
      if (change[1] === "-") {
        if (removed) return undefined;
        removed = { line: number, before: content };
      } else {
        if (removed?.line !== number) return undefined;
        current.push({ line: number, before: removed.before, after: content });
        removed = undefined;
      }
      continue;
    }
    if (removed) return undefined;
    const file = SINGLE_FILE.exec(line) ?? TREE_FILE.exec(line);
    if (file) {
      const depth = file.length === 3 ? (file[1] ?? "").length - 1 : 0;
      directories.length = depth;
      const path = directories.join("") + (file.at(-1) ?? "");
      current = files.get(path) ?? [];
      files.set(path, current);
      continue;
    }
    const directory = TREE_DIRECTORY.exec(line);
    if (!directory) return undefined;
    const depth = (directory[1] ?? "").length - 1;
    directories.length = depth;
    directories[depth] = directory[2] ?? "";
    current = undefined;
  }
  if (removed) return undefined;
  const parsed = ompAstEditSchema.safeParse({
    files: [...files].map(([path, changes]) => ({ path, changes })),
  });
  return parsed.success ? parsed.data : undefined;
}

const textBlockSchema = z.looseObject({ type: z.string(), text: z.string().optional() });
const astEditRowSchema = z.object({
  name: z.literal("ast_edit"),
  callId: z.string(),
  status: z.literal("completed"),
  detail: z.union([
    z.object({ type: z.literal("plain_text"), text: z.string() }),
    z.object({
      type: z.literal("unknown"),
      output: z.looseObject({ content: z.array(textBlockSchema) }),
    }),
  ]),
});

/**
 * Replaces a completed built-in `ast_edit` row with a read-only diff card. The built-in provider
 * passes only the result text (as a plain text row, or as the raw result for an unmapped tool), so
 * a row whose text does not parse stays as is.
 */
export function transformOmpAstEditItem(item: unknown) {
  const row = astEditRowSchema.safeParse(item);
  if (!row.success) return undefined;
  const { detail } = row.data;
  const text =
    detail.type === "plain_text"
      ? detail.text
      : detail.output.content
          .flatMap((block) => (block.text === undefined ? [] : [block.text]))
          .join("\n");
  const data = parseOmpAstEdit(text);
  if (!data) return undefined;
  return {
    items: [
      { type: "plugin" as const, kind: OMP_AST_EDIT_KIND, id: row.data.callId, version: 1, data },
    ],
  };
}
