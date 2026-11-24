/** Return a fixed, safe remedy from Prisma's verification envelope, never raw logs/URLs/SQL. */
export function databaseStartupProblem(output) {
  for (const line of output.split(/\r?\n/).reverse()) {
    // --no-log-prefix produces JSON lines. Also tolerate older Compose's prefix.
    const start = line.indexOf("{");
    if (start < 0) continue;
    let record;
    try { record = JSON.parse(line.slice(start)); } catch { continue; }
    if (!["db.verify", "db.prepare-local"].includes(record.commandId) || record.kind !== "result") continue;
    const diagnostics = Array.isArray(record.envelope?.diagnostics) ? record.envelope.diagnostics : [];
    const codes = new Set(diagnostics.map(diagnostic => diagnostic?.code));
    if (record.commandId === "db.prepare-local") {
      // The preparation command owns a bounded set of sanitized diagnostics.
      // Never forward arbitrary provider messages, SQL or connection details.
      if (codes.has("LOCAL_DATABASE_NOT_EMPTY") || codes.has("DATABASE_INITIALIZATION_REQUIRES_EMPTY")) return "Local database contains existing objects without a compatible signature. Open Database → Database status and inspect Local PostgreSQL before reviewing recovery. Startup preserves existing storage; it cannot adopt or reset it.";
      if (codes.has("LOCAL_DATABASE_TARGET_REFUSED")) return "Local database preparation refused a destination outside the Compose PostgreSQL database. Review the prisma-verify service's DATABASE_URL in your Compose override before retrying.";
      if (codes.has("LOCAL_DATABASE_MISSING")) return "Local PostgreSQL is reachable, but the configured database is missing from its retained cluster. Review Compose settings and existing databases before repair; startup did not reset the volume or recreate that database.";
      if (codes.has("LOCAL_DATABASE_LOGIN_FAILED")) return "Local PostgreSQL rejected its configured login. POSTGRES_USER and POSTGRES_PASSWORD only initialize new volumes; review retained roles and Compose settings before retrying. Startup did not reset storage or change logins.";
      if (["LOCAL_DATABASE_CONFIG_INVALID", "LOCAL_DATABASE_CONTRACT_INVALID", "LOCAL_DATABASE_SOURCE_CHANGED"].some(code => codes.has(code))) return "Local database preparation could not use the saved contract or configuration. Fix the database source, rebuild, and retry local runtime.";
      if (["LOCAL_DATABASE_PREPARATION_FAILED", "LOCAL_DATABASE_VERIFICATION_FAILED", "LOCAL_DATABASE_INITIALIZATION_FAILED"].some(code => codes.has(code))) return "Local database preparation could not be confirmed. Open Database → Database status and inspect Local PostgreSQL before retrying. Existing databases are never reset or adopted during startup.";
    }
    if (codes.has("CONTRACT.MARKER_MISSING")) return "Local database needs initialization: no database signature was found. Open Database → Database status, inspect Local PostgreSQL, then review initialization. A populated database needs separate investigation; startup will not sign or reset it.";
    if (codes.has("CONTRACT.MARKER_MISMATCH")) return "Local database and checkout use different contract versions. Open Database → Database status, inspect Local PostgreSQL, then review a matching migration path. A branch switch can leave the database ahead or on another branch; startup will not downgrade or reset it.";
    if (codes.has("CONTRACT.SCHEMA_VERIFICATION_FAILED")) return "Local database schema does not match the saved contract. Open Database → Database status, inspect Local PostgreSQL, then review the reported schema differences before applying a repair or migration.";
    if (record.envelope?.result?.ok === false || record.envelope?.ok === false) return "Local database verification failed. Open Database → Database status and inspect Local PostgreSQL before restarting local runtime. Inspect prisma-verify's container logs for the underlying database diagnostic.";
  }
  return undefined;
}
