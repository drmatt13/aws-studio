import { existsSync } from "node:fs";
import path from "node:path";
import { projectComposeSources } from "aws-studio/compose-services";
import { isMap, isScalar, parseDocument } from "yaml";
import type { LocalDatabase } from "../shared/database";
import type { ModeModel } from "../shared/model";

// The declared-schema parser belongs to the contract verifier; Studio projects it.
export { CONTRACT_FILE, parseDeclaredSchema, readDeclaredSchema, type DeclaredPrismaReview } from "aws-studio/contract-chain/declared-schema";

/** A narrow projection of authored Compose facts. Never return environment or connection values. */
export function readLocalDatabases(root: string): { services: readonly LocalDatabase[]; problems: readonly string[] } {
  const file = "docker-compose.yml";
  if (!existsSync(path.join(root, file))) return { services: [], problems: [] };
  try {
    const declaration = projectComposeSources(root).find(source => source.model.services?.postgres);
    const service = declaration?.model.services?.postgres;
    if (!declaration || !service) return { services: [], problems: [] };
    const { text } = declaration;
    // Use YAML node ranges: `postgres` can also occur in dependency anchors before services.
    const services = parseDocument(text).get("services", true);
    const key = isMap(services) ? services.items.find((item) => isScalar(item.key) && item.key.value === "postgres")?.key : undefined;
    if (!isScalar(key) || !key.range) return { services: [], problems: ["The Compose postgres declaration could not be located."] };
    const start = key.range[0];
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const image = typeof service.image === "string" && /^[\w./:@-]+$/.test(service.image) ? service.image : "Image configured in Compose";
    const volumes = (Array.isArray(service.volumes) ? service.volumes : []).flatMap((entry) => {
      const source = typeof entry === "string" ? entry.split(":")[0] : entry && typeof entry === "object" ? entry.source : undefined;
      return typeof source === "string" && /^[\w-]+$/.test(source) ? [source] : [];
    });
    return { services: [{ id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image, volumes, enabled: true,
      source: { file: declaration.file, line: text.slice(0, start).split("\n").length, column: start - lineStart + 1, start, end: key.range[1] } }], problems: [] };
  } catch {
    // YAML errors can contain source excerpts, including secrets; expose only the file name.
    return { services: [], problems: [`Cannot read PostgreSQL from ${file}. Check the Compose YAML.`] };
  }
}

export function withLocalDatabases(model: ModeModel, services: readonly LocalDatabase[]): ModeModel {
  const postgres = services[0];
  const targets = new Map(model.targets.map((target) => [target.ref, target]));
  const edgeIds = new Set(model.edges.map((edge) => edge.id));
  return { ...model, localServices: services.map((service) => ({ ...service, enabled: model.mode === "dev" })),
    edges: model.edges.flatMap((edge) => {
      const target = targets.get(edge.from);
      if (!postgres || model.mode !== "dev" || edge.relation !== "database" || !target?.lanes.local || edge.to === postgres.id) return [edge];
      // A development replay Lambda captures events; its handler and database access run locally.
      const cloud = target.lanes.dev && !(target.compute.kind === "lambda" && target.compute.localReplay);
      if (edgeIds.has(`${edge.id}:local`)) return cloud ? [edge] : [];
      const local = { ...edge, id: `${edge.id}:local`, to: postgres.id, provenance: "derived" as const,
        detail: "Local execution uses Compose PostgreSQL through the framework database binding. Writer and reader roles share this database." };
      return cloud ? [edge, local] : [local];
    }),
  };
}
