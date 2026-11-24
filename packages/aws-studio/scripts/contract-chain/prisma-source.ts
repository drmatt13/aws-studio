import { createHash } from "node:crypto";
import { isPrismaNextSchema } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { accessSourceAttachments } from "../../database/client-access";
import { commentStart, readDirectives } from "../../database/access-syntax";
import { portableFileDigest } from "./portable-dependencies";

export const PRISMA_CONTRACT_FILE = "packages/database/prisma/contract.prisma";
const MAX_PRISMA_BYTES = 512 * 1024;

/** Proof and presentation ignore prose while exact capture continues to bind the original bytes. */
export function prismaContractDigest(bytes: Buffer): string {
  const originalDigest = () => portableFileDigest(PRISMA_CONTRACT_FILE, bytes);
  if (bytes.length > MAX_PRISMA_BYTES || bytes.includes(0)) return originalDigest();
  const original = bytes.toString("utf8");
  if (!Buffer.from(original).equals(bytes)) return originalDigest();
  const text = original.replaceAll("\r\n", "\n");
  try {
    if (parse(text, PRISMA_CONTRACT_FILE).diagnostics.length) return originalDigest();
    return createHash("sha256").update(projectPrismaSource(text)).digest("hex");
  } catch { return originalDigest(); }
}

function projectPrismaSource(text: string): string {
  const { targets, retiredLines } = /@access\b/.test(text) ? accessSourceAttachments(text) : { targets: [], retiredLines: [] };
  const policyLines = new Set(retiredLines);
  for (const directive of readDirectives(text)) for (let line = directive.line; line <= directive.endLine; line++) policyLines.add(line);

  const content = text.split("\n").map((line, index) => {
    const comment = commentStart(line);
    return (comment < 0 || policyLines.has(index + 1) ? line : line.slice(0, comment)).trimEnd();
  }).filter(Boolean);
  // The compiler requires its opt-in pragma at the start. Attributes such as
  // @@check are authored Prisma tokens and remain in the source projection.
  return JSON.stringify([isPrismaNextSchema(text), content, targets]);
}
