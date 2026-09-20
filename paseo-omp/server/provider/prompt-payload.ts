import type { ProviderContent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { getForgeDefinitionOrNeutral } from "@getpaseo/protocol/forge-manifest";
import { isValidImagePayload } from "./image";
import type { OmpImage } from "./omp-rpc";
import { OmpPublicError, utf8Bytes } from "./security";

type SessionPromptInput = Extract<ProviderInput, { type: "session.prompt" }>;
const MAX_PROMPT_PARTS = 64;
export const MAX_PROMPT_TEXT_LENGTH = 1024 * 1024;
const RPC_REQUEST_ID_BYTES = 36;

export function isSafeCommandName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(name);
}

export type OmpPromptPayload = { text: string; images: OmpImage[]; commandName?: string };

const REVIEW_LINE_MARKERS = { add: "+", remove: "-", context: " " } as const;

function renderPromptAttachmentAsText(part: Exclude<ProviderContent, { type: "image" }>): string {
  switch (part.type) {
    case "forge_change_request": {
      return renderChangeRequestAttachment({
        forge: part.forge ?? "github",
        number: part.number,
        title: part.title,
        url: part.url,
        body: part.body,
        projectPath: part.projectPath,
        baseRefName: part.baseRefName,
        headRefName: part.headRefName,
      });
    }
    case "github_pr": {
      return renderChangeRequestAttachment({
        forge: "github",
        number: part.number,
        title: part.title,
        url: part.url,
        body: part.body,
        baseRefName: part.baseRefName,
        headRefName: part.headRefName,
      });
    }
    case "forge_issue": {
      return renderIssueAttachment({
        forge: part.forge ?? "github",
        number: part.number,
        title: part.title,
        url: part.url,
        body: part.body,
        projectPath: part.projectPath,
      });
    }
    case "github_issue": {
      return renderIssueAttachment({
        forge: "github",
        number: part.number,
        title: part.title,
        url: part.url,
        body: part.body,
      });
    }
    case "text": {
      return part.text;
    }
    case "review": {
      const lines = [`Paseo review attachment (${part.mode})`, `CWD: ${part.cwd}`];
      if (part.baseRef) {
        lines.push(`Base: ${part.baseRef}`);
      }
      part.comments.forEach((comment, index) => {
        lines.push(
          "",
          `Comment ${index + 1}: ${comment.filePath}:${comment.side}:${comment.lineNumber}`,
          comment.body,
          comment.context.hunkHeader,
        );
        const target = comment.context.targetLine;
        for (const line of comment.context.lines) {
          const isTarget =
            line.oldLineNumber === target.oldLineNumber &&
            line.newLineNumber === target.newLineNumber &&
            line.type === target.type &&
            line.content === target.content;
          const prefix = isTarget ? "> " : "  ";
          const oldLn = padLineNumber(line.oldLineNumber);
          const newLn = padLineNumber(line.newLineNumber);
          lines.push(`${prefix}${oldLn} ${newLn} ${REVIEW_LINE_MARKERS[line.type]}${line.content}`);
        }
      });
      return lines.join("\n");
    }
    case "uploaded_file": {
      return [
        `Uploaded file: ${part.fileName}`,
        `Path: ${part.path}`,
        `MIME: ${part.mimeType}`,
        `Size: ${part.size} bytes`,
      ].join("\n");
    }
    default:
      throw new Error("unreachable");
  }
}

function renderChangeRequestAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} ${formatChangeRequestAbbrev(input.forge)} ${formatChangeRequestNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.baseRefName) {
    lines.push(`Base: ${input.baseRefName}`);
  }
  if (input.headRefName) {
    lines.push(`Head: ${input.headRefName}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function renderIssueAttachment(input: {
  forge: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}): string {
  const lines = [
    `${formatForgeLabel(input.forge)} Issue ${formatIssueNumber(input.forge, input.number)}: ${input.title}`,
    input.url,
  ];
  if (input.projectPath) {
    lines.push(`Project: ${input.projectPath}`);
  }
  if (input.body) {
    lines.push("", input.body);
  }
  return lines.join("\n");
}

function formatForgeLabel(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).displayName;
}

function formatChangeRequestAbbrev(forge: string): string {
  return getForgeDefinitionOrNeutral(forge).changeRequestAbbrev;
}

function formatChangeRequestNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).changeRequestNumberPrefix}${number}`;
}

function formatIssueNumber(forge: string, number: number): string {
  return `${getForgeDefinitionOrNeutral(forge).issueNumberPrefix}${number}`;
}

function padLineNumber(lineNumber: number | null): string {
  return (lineNumber?.toString() ?? "-").padStart(2);
}

export function promptPayload(input: SessionPromptInput): OmpPromptPayload {
  if (input.prompt.outputSchema !== undefined || input.prompt.clearPendingPermissions) {
    throw new OmpPublicError("OMP does not support structured output or permission controls");
  }
  if (input.prompt.input.type === "command") {
    const name = input.prompt.input.name.trim();
    if (!isSafeCommandName(name)) throw new OmpPublicError("Invalid OMP command name");
    const argumentsText = input.prompt.input.arguments.trim();
    const text = `/${name}${argumentsText ? ` ${argumentsText}` : ""}`;
    if (utf8Bytes(text) > MAX_PROMPT_TEXT_LENGTH)
      throw new OmpPublicError("OMP command is too large");
    return { text, images: [], commandName: name };
  }
  if (input.prompt.input.content.length > MAX_PROMPT_PARTS) {
    throw new OmpPublicError("OMP prompt has too many content parts");
  }
  const parts: string[] = [];
  const images: OmpImage[] = [];
  let length = 0;
  const appendText = (text: string) => {
    length += utf8Bytes(text) + (parts.length > 0 ? 2 : 0);
    if (length > MAX_PROMPT_TEXT_LENGTH) throw new OmpPublicError("OMP prompt is too large");
    parts.push(text);
  };
  for (const part of input.prompt.input.content) {
    if (part.type === "text") {
      appendText(part.text);
      continue;
    }
    if (part.type === "image") {
      if (!isValidImagePayload(part.data, part.mimeType, 8 * 1024 * 1024)) {
        throw new OmpPublicError("OMP prompt image is invalid");
      }
      images.push({ type: "image", data: part.data, mimeType: part.mimeType });
      continue;
    }
    appendText(renderPromptAttachmentAsText(part));
  }
  const text = parts.join("\n\n").trim();
  if (!text && images.length === 0) throw new OmpPublicError("OMP prompt cannot be empty");
  return { text, images };
}

export function inlinePromptFrameBytes(
  payload: OmpPromptPayload,
  delivery: "prompt" | "steer",
): number {
  const images = payload.images.map(({ type, mimeType }) => ({ type, data: "", mimeType }));
  const frame = {
    type: delivery,
    message: payload.text,
    ...(images.length > 0 ? { images } : {}),
    ...(delivery === "prompt" ? { id: "" } : {}),
  };
  const requestIdBytes = delivery === "prompt" ? RPC_REQUEST_ID_BYTES : 0;
  return (
    utf8Bytes(JSON.stringify(frame)) +
    requestIdBytes +
    payload.images.reduce((total, image) => total + image.data.length, 0) +
    1
  );
}

export function slashCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const body = text.slice(1);
  if (!body) return undefined;
  const firstWhitespace = body.search(/\s/u);
  const name = firstWhitespace === -1 ? body : body.slice(0, firstWhitespace);
  return name || undefined;
}
