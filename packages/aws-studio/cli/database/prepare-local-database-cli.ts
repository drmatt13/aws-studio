import { frameworkRepositoryRoot } from "aws-studio/config/source";
import { localPreparationEnvelope, prepareLocalDatabase } from "./prepare-local-database.js";

// The Compose command supplies DATABASE_URL explicitly. Never inherit the
// authored Prisma config's connection or accept an arbitrary command-line URL.
const preparation = process.argv.length > 2
  ? { ok: false, status: "failed" as const, code: "LOCAL_DATABASE_OPTIONS_REFUSED", message: "Local database preparation takes no command-line options. Run the local runtime through Studio or npm run dev:containers.", exitCode: 1 }
  : await prepareLocalDatabase({ root: frameworkRepositoryRoot(), connection: process.env.DATABASE_URL });
console.log(JSON.stringify(localPreparationEnvelope(preparation)));
process.exitCode = preparation.exitCode;
