import { Eye, Link2, Lock, UserRound, UsersRound, ShieldCheck, Pencil, Plus, Trash2, type LucideIcon } from "lucide-react";
import type { AccessWord } from "aws-studio/database/client-access";

export const FIELD_ACCESS_SHORTCUT = "⌘/Ctrl+.";

export const ACCESS_ICONS: Readonly<Record<AccessWord, LucideIcon>> = {
  "server-only": Lock,
  "read-only": Eye,
  owner: UserRound,
  members: UsersRound,
  via: Link2, role: ShieldCheck, read: Eye, write: Pencil, create: Plus, update: Pencil, delete: Trash2,
};

export const ACCESS_TONES: Readonly<Record<AccessWord, string>> = {
  "server-only": "text-refuse",
  "read-only": "text-local",
  owner: "text-[var(--access-owner)]",
  members: "text-[var(--access-members)]",
  via: "text-[var(--access-via)]",
  role: "text-prod", read: "text-local", write: "text-dev", create: "text-dev", update: "text-dev", delete: "text-refuse",
};

export interface FieldAccessAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  /** Live source target, so the popup can follow editor scrolling and layout changes. */
  readonly element?: Element;
}
