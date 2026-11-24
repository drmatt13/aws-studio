import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { assertAgentSourcePath, isDependencyCachePath } from "aws-studio/source/workspace";
import { DATABASE_RUNTIME_OUTPUTS } from "aws-studio/contract-chain/runtime-artifacts";
import { invalidateDependencyIdentity } from "aws-studio/contract-chain/dependencies";

/** Match the captured public source/dependency inventory before admitting a watch event. */
export function isGraphQLChainWatchInput(filename: string | undefined): boolean {
  if (!filename) return true; // A native event without a path cannot establish freshness.
  const file = filename.split(path.sep).join("/"), parts = file.split("/");
  if (file.includes("\\") || path.posix.isAbsolute(file) || parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f:]/.test(part))) return false;
  if (DATABASE_RUNTIME_OUTPUTS.some(output => output === file)) return true;
  if (file.startsWith("client-app/src/api/")) return true;
  const modules = parts.indexOf("node_modules");
  const publicParts = modules < 0 ? parts.length : modules;
  // Admission is checked at every ancestor, just as source capture recursively
  // excludes a directory before visiting children. Fixture node_modules inside
  // .cache/.framework/output must never be mistaken for installed dependencies.
  try {
    for (let count = 1; count <= publicParts; count++) assertAgentSourcePath(parts.slice(0, count).join("/"));
  } catch { return false; }
  if (modules < 0) return true;
  return !isDependencyCachePath(file);
}

/** Access time is not source identity. Genuine write notifications are handled
 * separately because even nanosecond ctime/mtime can collide on same-size edits. */
export function watchFileStamp(info: BigIntStats): string {
  return JSON.stringify([String(info.dev), String(info.ino), String(info.mode),
    ...(info.isDirectory() ? [] : [String(info.size), String(info.nlink), String(info.ctimeNs), String(info.mtimeNs)])]);
}

export class GraphQLChainWatchInputs {
  private stamps: Map<string, string>;
  private dependencyGeneration = 0;
  constructor(private readonly root: string) { this.stamps = this.snapshot(); }
  private snapshot(prefix = ""): Map<string, string> {
    const stamps = new Map<string, string>();
    const visit = (name: string) => {
      if (name && !isGraphQLChainWatchInput(name)) return;
      if (stamps.size > 500_000) throw new Error("Contract watch inputs exceed the bounded inventory.");
      const file = path.join(this.root, name);
      let info: BigIntStats;
      try { info = lstatSync(file, { bigint: true }); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
      if (name) stamps.set(name, this.stamp(name, info));
      if (info.isDirectory()) for (const entry of readdirSync(file)) visit(name ? `${name}/${entry}` : entry);
    };
    visit(prefix);
    // Generated parents are excluded from public source; these fixed artifacts
    // nevertheless participate in executable contract validation.
    for (const file of DATABASE_RUNTIME_OUTPUTS) if (!prefix || file === prefix || file.startsWith(prefix + "/")) stamps.set(file, this.stamp(file));
    return stamps;
  }
  private stamp(name: string, info?: BigIntStats): string {
    try {
      info ??= lstatSync(path.join(this.root, name), { bigint: true });
      const children = info.isDirectory() ? readdirSync(path.join(this.root, name))
        .filter(child => isGraphQLChainWatchInput(`${name}/${child}`)).sort() : [];
      return JSON.stringify([watchFileStamp(info), children]);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return "missing";
      throw error;
    }
  }
  /** Metadata identity of every admitted dependency, including removed/renamed subtrees. */
  dependencyStamp(): string {
    const entries = [...this.stamps].filter(([name]) => name.split("/").includes("node_modules")).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return createHash("sha256").update(JSON.stringify([this.dependencyGeneration, entries])).digest("hex");
  }
  /** Metadata polls do not imply a write, unlike the filtered native callback. */
  changed(filename: string | undefined): boolean {
    return this.reconcile(filename, false);
  }
  /** The native bridge excludes access-only events. Equal metadata cannot erase
   * an observed write, a coarse directory event or a lost/overflowed filename. */
  notified(filename: string | undefined): boolean {
    return this.reconcile(filename, true);
  }
  private dependenciesChanged(): void {
    this.dependencyGeneration++;
    invalidateDependencyIdentity(this.root);
  }
  private reconcile(filename: string | undefined, notification: boolean): boolean {
    if (!filename) {
      const next = this.snapshot(), changed = next.size !== this.stamps.size || [...next].some(([name, stamp]) => this.stamps.get(name) !== stamp);
      const dependencies = notification || [...new Set([...next.keys(), ...this.stamps.keys()])].some(name => name.split("/").includes("node_modules") && next.get(name) !== this.stamps.get(name));
      this.stamps = next;
      if (dependencies) this.dependenciesChanged();
      return notification || changed;
    }
    if (!isGraphQLChainWatchInput(filename)) return false;
    const name = filename.split(path.sep).join("/"), next = this.stamp(name), previous = this.stamps.get(name);
    let directory = false;
    try { directory = lstatSync(path.join(this.root, name)).isDirectory(); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    if (!notification && !directory && next !== "missing" && previous === next) return false;
    const descendants = [...this.stamps.keys()].filter(file => file.startsWith(name + "/"));
    if (directory || descendants.length) {
      const current = this.snapshot(name), old = new Map([name, ...descendants].filter(file => this.stamps.has(file)).map(file => [file, this.stamps.get(file)!]));
      const changed = current.size !== old.size || [...current].some(([file, stamp]) => old.get(file) !== stamp);
      for (const file of old.keys()) this.stamps.delete(file);
      for (const [file, stamp] of current) this.stamps.set(file, stamp);
      if ((notification || changed) && [...new Set([...old.keys(), ...current.keys()])].some(file => file.split("/").includes("node_modules"))) this.dependenciesChanged();
      return notification || changed;
    }
    if (next === "missing" && !DATABASE_RUNTIME_OUTPUTS.some(file => file === name)) this.stamps.delete(name);
    else this.stamps.set(name, next);
    if ((notification || previous !== next) && name.split("/").includes("node_modules")) this.dependenciesChanged();
    return notification || previous !== next;
  }
}
