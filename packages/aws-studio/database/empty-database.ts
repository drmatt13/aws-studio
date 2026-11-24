import { createRequire } from "node:module";
import path from "node:path";

/** Metadata only. Schema dependencies include collations, operators, text search
 * objects and other namespaced families without maintaining a catalog allowlist.
 * Check every user type, including incomplete shell types, and database-scoped
 * objects that have no user-schema dependency. Stock plpgsql is part of initdb.
 * Partial control tables and extra user schemas also count as occupied.
 */
export const DATABASE_EMPTY_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_namespace n ON n.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_namespace'::pg_catalog.regclass AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','public')
  UNION ALL SELECT 1 FROM pg_catalog.pg_largeobject_metadata
  UNION ALL SELECT 1 FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
  UNION ALL SELECT 1 FROM pg_catalog.pg_event_trigger
  UNION ALL SELECT 1 FROM pg_catalog.pg_publication
  UNION ALL SELECT 1 FROM pg_catalog.pg_foreign_data_wrapper
  UNION ALL SELECT 1 FROM pg_catalog.pg_foreign_server
) AS occupied`;

function metadataClient(root: string, connection: string) {
  const pg = createRequire(path.join(root, "packages/database/package.json"))("pg") as { Client: new (options: { connectionString: string }) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> } };
  return new pg.Client({ connectionString: connection });
}
export async function isDatabaseEmpty(root: string, connection: string): Promise<boolean> {
  const client = metadataClient(root, connection);
  try { await client.connect(); return (await client.query(DATABASE_EMPTY_SQL)).rows[0]?.occupied === false; }
  finally { await client.end(); }
}
