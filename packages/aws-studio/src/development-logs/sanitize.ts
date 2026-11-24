import { StringDecoder } from "node:string_decoder";
import { types as nodeTypes } from "node:util";
import {
  DEVELOPMENT_LOG_LIMITS as limits,
  type DevelopmentLogOmission,
} from "./contract";

const sensitiveKey =
  /authorization|cookie|token|password|passwd|passphrase|secret|credential|private.?key|api.?key|access.?key|signature|__framework_identity|framework_task_callback/i;
const authBodyKey =
  /^(?:password|passwd|refresh_token|refreshToken|idToken|accessToken|client_secret|__framework_identity)$/i;
const marker = "[redacted]";
export const developmentSensitiveName = (name: string): boolean =>
  sensitiveKey.test(name);
export const developmentSensitiveHttpPath = (path: string): boolean =>
  /(?:^|\/)(?:auth|login|logout|signup|sign-in|sign-up|token|session|password|callback)(?:\/|$)/i.test(
    path,
  );
/** Typed HTTP auth events remain private when nested in workflow/task evidence too. */
export function developmentSensitiveHttpEvent(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || nodeTypes.isProxy(value))
      return false;
    const context = Object.getOwnPropertyDescriptor(
      value,
      "requestContext",
    )?.value;
    if (!context || typeof context !== "object" || nodeTypes.isProxy(context))
      return false;
    const http = Object.getOwnPropertyDescriptor(context, "http")?.value;
    if (!http || typeof http !== "object" || nodeTypes.isProxy(http))
      return false;
    const paths = [
      Object.getOwnPropertyDescriptor(value, "rawPath")?.value,
      Object.getOwnPropertyDescriptor(http, "path")?.value,
    ];
    return paths.some(
      (path) =>
        typeof path === "string" &&
        (path.length > 16 * 1024 || developmentSensitiveHttpPath(path)),
    );
  } catch {
    return false;
  }
}

const formCache = new WeakMap<readonly string[], readonly string[] | null>();
function secretForms(secrets: readonly string[]): readonly string[] | null {
  const cached = Object.isFrozen(secrets) ? formCache.get(secrets) : undefined;
  if (cached !== undefined) return cached;
  const forms = new Set<string>();
  let bytes = 0;
  const add = (value: string) => {
    if (!value || forms.has(value)) return true;
    bytes += value.length;
    if (forms.size >= 4096 || bytes > 4 * 1024 * 1024) return false;
    forms.add(value);
    return true;
  };
  let result: readonly string[] | null = null;
  try {
    let safe = true;
    for (const secret of secrets) {
      if (!secret) continue;
      if (secret === "__capture_suppressed__") {
        safe = false;
        break;
      }
      const encoded = encodeURIComponent(secret);
      if (
        ![
          secret,
          JSON.stringify(secret).slice(1, -1),
          encoded,
          encoded.replace(/%[A-F0-9]{2}/g, (part) => part.toLowerCase()),
        ].every(add)
      ) {
        safe = false;
        break;
      }
      // Line-oriented producers must also protect a known multiline credential's pieces.
      for (let start = 0; start < secret.length;) {
        const newline = secret.indexOf("\n", start);
        if (newline < 0 && start === 0) break;
        if (
          !add(
            secret
              .slice(start, newline < 0 ? secret.length : newline)
              .replace(/\r$/, ""),
          )
        ) {
          safe = false;
          break;
        }
        if (newline < 0) break;
        start = newline + 1;
      }
      if (!safe) break;
    }
    if (safe) result = [...forms].sort((a, b) => b.length - a.length);
  } catch {
    /* Invalid or excessive dictionaries suppress output. */
  }
  if (Object.isFrozen(secrets)) formCache.set(secrets, result);
  return result;
}

export function sanitizeDevelopmentText(
  input: string,
  secrets: readonly string[] = [],
): string {
  const forms = secretForms(secrets);
  if (!forms) return "[sensitive output omitted]";
  let text = input;
  for (const secret of forms) text = text.split(secret).join(marker);
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      "[private key omitted]",
    )
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, marker)
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
      marker,
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, marker)
    .replace(/\bwf-[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g, marker)
    .replace(
      /((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi,
      `$1${marker}`,
    )
    .replace(
      /((?:password|passwd|passphrase|(?:[\w-]*[_-])?(?:token|secret|credential|api[_-]?key|access[_-]?key)|__framework_identity|FRAMEWORK_TASK_CALLBACK)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      `$1${marker}`,
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${marker}@`)
    .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/gi, "$1?[query omitted]")
    .replace(
      /([?&](?:[^=&\s]*(?:token|secret|signature|credential|password|code)|X-Amz-[^=&\s]+)=)[^&\s]*/gi,
      `$1${marker}`,
    )
    .replace(/(\/callbacks\/)[^\s/]+/g, `$1${marker}`)
    .replace(
      /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s:)]+|\/(?:Users|home)\/[^\s:)]+)/g,
      "[private path]",
    );
}

function cut(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = Buffer.from(text)
    .subarray(0, Math.max(0, bytes - 24))
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return result + "[truncated]";
}
export interface DevelopmentPreviewOptions {
  readonly contentType?: string;
  readonly sensitive?: boolean;
  readonly secrets?: readonly string[];
  readonly limit?: number;
}
export function sanitizeDevelopmentValue(
  input: unknown,
  options: DevelopmentPreviewOptions = {},
): { value: unknown; omissions: DevelopmentLogOmission[] } {
  const omissions: DevelopmentLogOmission[] = [];
  const omit = (
    path: string,
    reason: DevelopmentLogOmission["reason"],
    value = "[omitted]",
  ): string => {
    if (omissions.length < 32)
      omissions.push({ path: path.slice(0, 160), reason });
    return value;
  };
  const cap = Math.max(
    64,
    Math.min(options.limit ?? limits.previewBytes, limits.previewBytes),
  );
  if (options.sensitive || options.secrets?.includes("__capture_suppressed__"))
    return {
      value: omit("$", "privacy", "[sensitive payload omitted]"),
      omissions,
    };
  if (nodeTypes.isProxy(input))
    return { value: omit("$", "unsupported", "[proxy omitted]"), omissions };
  let source = input;
  const type = options.contentType?.split(";")[0]?.trim().toLowerCase();
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (
      !type ||
      (![
        "application/json",
        "application/x-www-form-urlencoded",
        "text/plain",
      ].includes(type) &&
        !type.endsWith("+json")) ||
      input.byteLength > 64 * 1024
    )
      return {
        value: omit(
          "$",
          "unsupported",
          `[body omitted; ${input.byteLength} bytes]`,
        ),
        omissions,
      };
    source = Buffer.from(input).toString("utf8");
  }
  if (
    type &&
    ![
      "application/json",
      "application/x-www-form-urlencoded",
      "text/plain",
    ].includes(type) &&
    !type.endsWith("+json")
  )
    return {
      value: omit("$", "unsupported", "[content type omitted]"),
      omissions,
    };
  if (
    typeof source === "string" &&
    (type === "application/json" || type?.endsWith("+json"))
  ) {
    if (Buffer.byteLength(source) > 64 * 1024)
      return {
        value: omit("$", "size", "[oversized JSON omitted]"),
        omissions,
      };
    try {
      source = JSON.parse(source);
    } catch {
      return {
        value: omit("$", "unsupported", "[invalid JSON omitted]"),
        omissions,
      };
    }
  }
  if (
    typeof source === "string" &&
    type === "application/x-www-form-urlencoded"
  ) {
    if (Buffer.byteLength(source) > 64 * 1024)
      return { value: omit("$", "size"), omissions };
    source = Object.fromEntries(new URLSearchParams(source));
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): unknown => {
    if (++nodes > 256) return omit(path, "size");
    if (depth > 6) return omit(path, "depth");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number")
      return Number.isFinite(value) ? value : omit(path, "unsupported");
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > limits.frameBytes)
        return omit(path, "size", "[oversized string omitted]");
      if (/^\s*[\[{]/.test(value)) {
        try {
          return visit(JSON.parse(value), `${path}.$json`, depth + 1);
        } catch {
          /* Ordinary text uses the text policy. */
        }
      }
      if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(value)) {
        try {
          return visit(
            Object.fromEntries(new URLSearchParams(value)),
            `${path}.$form`,
            depth + 1,
          );
        } catch {
          /* Bounded text below. */
        }
      }
      const safe = sanitizeDevelopmentText(value, options.secrets);
      if (safe !== value && omissions.length < 32)
        omissions.push({ path, reason: "privacy" });
      if (Buffer.byteLength(safe) > limits.stringBytes) {
        omit(path, "size");
        return cut(safe, limits.stringBytes);
      }
      return safe;
    }
    if (typeof value !== "object") return omit(path, "unsupported");
    if (nodeTypes.isProxy(value))
      return omit(path, "unsupported", "[proxy omitted]");
    if (developmentSensitiveHttpEvent(value))
      return omit(path, "privacy", "[sensitive HTTP event omitted]");
    if (Buffer.isBuffer(value) || value instanceof Uint8Array)
      return omit(
        path,
        "unsupported",
        `[binary omitted; ${value.byteLength} bytes]`,
      );
    if (seen.has(value)) return omit(path, "circular");
    seen.add(value);
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        return omit(path, "unsupported");
      if (length > 32) omit(path, "size");
      const result: unknown[] = [];
      for (let index = 0; index < Math.min(length, 32); index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        result.push(
          descriptor && "value" in descriptor
            ? visit(descriptor.value, `${path}[${index}]`, depth + 1)
            : omit(`${path}[${index}]`, "unsupported"),
        );
      }
      return result;
    }
    if (value instanceof Error) {
      const fields: Record<string, unknown> = {};
      for (const key of ["name", "message", "stack", "cause", "errors"]) {
        let owner: object | null = value;
        for (
          let step = 0;
          owner && step < 6;
          step++, owner = Object.getPrototypeOf(owner)
        ) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, key);
          if (!descriptor) continue;
          fields[key] =
            "value" in descriptor
              ? descriptor.value
              : omit(
                  `${path}.${key}`,
                  "unsupported",
                  "[error accessor omitted]",
                );
          break;
        }
      }
      return visit(fields, path, depth + 1);
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return omit(path, "unsupported");
    const descriptors: [string, PropertyDescriptor][] = [];
    let inspected = 0;
    for (const key in value) {
      if (inspected++ >= 64) {
        omit(path, "size");
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (authBodyKey.test(key))
        return omit(path, "privacy", "[sensitive payload omitted]");
      descriptors.push([key, descriptor]);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of descriptors) {
      if (key.length > 1024) {
        omit(path, "size");
        continue;
      }
      const safeKey = cut(sanitizeDevelopmentText(key, options.secrets), 128);
      result[safeKey] = sensitiveKey.test(key)
        ? omit(`${path}.${safeKey}`, "privacy", marker)
        : !("value" in descriptor)
          ? omit(`${path}.${safeKey}`, "unsupported")
          : visit(descriptor.value, `${path}.${safeKey}`, depth + 1);
    }
    return result;
  };
  let value: unknown;
  try {
    value = visit(source, "$", 0);
  } catch {
    value = omit("$", "unsupported");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > cap) {
    // Do not slice serialized JSON: it can cut a credential/escape or misrepresent structure.
    if (typeof value === "string") value = cut(value, Math.max(32, cap - 4));
    else value = "[structured preview exceeds limit]";
    omit("$", "size");
  }
  return { value, omissions };
}

/** Never release an unfinished line that could contain a credential spanning chunks. */
export class DevelopmentTextFramer {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private discarding = false;
  private sensitiveContinuation = false;
  private privateBlock = false;
  constructor(
    private readonly emit: (text: string) => void,
    private readonly secrets: readonly string[] = [],
  ) {
    this.secrets = Object.isFrozen(secrets)
      ? secrets
      : Object.freeze([...secrets]);
  }
  push(chunk: string | Buffer): void {
    if (typeof chunk !== "string") {
      // Decode incrementally even if a producer hands us one unusually large write.
      for (let offset = 0; offset < chunk.length; offset += 16 * 1024)
        this.push(
          this.decoder.write(chunk.subarray(offset, offset + 16 * 1024)),
        );
      return;
    }
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      if (!this.discarding) {
        if (end - offset + this.pending.length > limits.frameBytes) {
          this.pending = "";
          this.discarding = true;
          this.output("[oversized output omitted]\n");
        } else {
          this.pending += chunk.slice(offset, end);
          if (Buffer.byteLength(this.pending) > limits.frameBytes) {
            this.pending = "";
            this.discarding = true;
            this.output("[oversized output omitted]\n");
          }
        }
      }
      if (newline >= 0) {
        if (!this.discarding) this.output(this.pending);
        this.pending = "";
        this.discarding = false;
      }
      offset = end;
    }
  }
  flush(): void {
    this.push(this.decoder.end());
    if (this.pending) {
      let ambiguous = 0;
      const forms = secretForms(this.secrets);
      for (const secret of forms ?? [])
        ambiguous = Math.max(
          ambiguous,
          suffixPrefixLength(this.pending, secret),
        );
      this.output(
        ambiguous
          ? `${this.pending.slice(0, -ambiguous)}[unfinished sensitive output omitted]`
          : this.pending,
      );
    }
    this.pending = "";
    this.discarding = false;
    this.sensitiveContinuation = false;
    this.privateBlock = false;
  }
  private output(text: string): void {
    try {
      if (this.privateBlock) {
        if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text))
          this.privateBlock = false;
        this.emit("[private key continuation omitted]\n");
        return;
      }
      if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) {
        this.privateBlock = !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
        this.emit("[private key omitted]\n");
        return;
      }
      // A dangling assignment has no reliable plaintext delimiter. Fail closed until stream reset.
      if (this.sensitiveContinuation) {
        this.emit("[sensitive continuation omitted]\n");
        return;
      }
      if (/\bwf-[A-Za-z0-9_-]{0,31}\s*$/.test(text)) {
        this.sensitiveContinuation = true;
        this.emit("[callback token fragment omitted]\n");
        return;
      }
      if (
        /(?:authorization|cookie|token|password|passwd|secret|credential|__framework_identity)["']?\s*[:=]\s*$/i.test(
          text,
        )
      ) {
        this.sensitiveContinuation = true;
        this.emit("[sensitive assignment omitted]\n");
        return;
      }
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const preview = sanitizeDevelopmentValue(JSON.parse(trimmed), {
            secrets: this.secrets,
          });
          this.emit(
            `${JSON.stringify(preview.value)}${text.endsWith("\n") ? "\n" : ""}`,
          );
          return;
        } catch {
          /* Text policy below. */
        }
      }
      this.emit(sanitizeDevelopmentText(text, this.secrets));
    } catch {
      /* Diagnostics never change stream/application outcomes. */
    }
  }
}

/** Linear-time longest proper credential prefix at an unfinished stream boundary. */
function suffixPrefixLength(text: string, credential: string): number {
  const length = Math.min(credential.length - 1, text.length);
  if (length <= 0) return 0;
  const pattern = credential.slice(0, length);
  const prefixes = new Uint32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    while (matched && pattern[index] !== pattern[matched])
      matched = prefixes[matched - 1]!;
    if (pattern[index] === pattern[matched]) matched++;
    prefixes[index] = matched;
  }
  let matched = 0;
  for (
    let index = Math.max(0, text.length - length);
    index < text.length;
    index++
  ) {
    while (matched && text[index] !== pattern[matched])
      matched = prefixes[matched - 1]!;
    if (text[index] === pattern[matched]) matched++;
  }
  return matched;
}
