import { testProjectRoot, testProjectScratchRoot } from "../../../../scripts/test-project";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { CodegenConfig } from "@graphql-codegen/cli";
import {
  planFeature,
  writeFeature,
  type Choices,
  type Metadata,
} from "../../cli/database/scaffold.js";
import { readClientAccess, renderClientAccess } from "aws-studio/database/client-access";
const root = testProjectRoot;
const scaffoldContract = JSON.parse(readFileSync(join(root, "packages/database/prisma/migrations/snapshots/518f79d59ebe3ed7d871ed006f788079416d1da9cdafa9b9ff66b18457871881/contract.json"), "utf8"));
// Studio mounts the source checkout read-only during independent checks.
const cache = resolve(process.env.STUDIO_CONTRACT_TEST_ROOT || join(testProjectScratchRoot, ".cache"));
const schemaPath = "compute/http/graphql-api/schema";
const choices: Choices = {
  model: "Note",
  publicFields: ["id", "name", "archived"],
  createFields: ["name"],
  owner: "ownerId",
  query: "notes",
  mutation: "createNote",
  selection: ["id", "name"],
};

function fixture() {
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "contract-scaffold-"));
  const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, packageManager }));
  cpSync(join(root, ".nvmrc"), join(directory, ".nvmrc"));
  writeFileSync(join(directory, "framework.config.ts"), "");
  for (const path of [
    "packages/database/src/contracts.ts",
    "packages/database/src/index.ts",
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path));
  }
  mkdirSync(join(directory, schemaPath), { recursive: true });
  writeFileSync(
    join(directory, schemaPath, "index.ts"),
    'import { builder } from "./builder";\nexport const schema = builder.toSchema();\n',
  );
  // The scaffold recipe fixture must stay stable as application models evolve.
  const metadata = structuredClone(scaffoldContract) as Metadata;
  const model = metadata.domain.namespaces.public.models.Project;
  metadata.domain.namespaces.public.models.Note = structuredClone(model);
  metadata.domain.namespaces.public.models.Note.storage.table = "notes";
  metadata.roots.notes = { model: "Note", namespace: "public" };
  metadata.storage.namespaces.public.entries.table.notes = structuredClone(
    metadata.storage.namespaces.public.entries.table.projects,
  );
  metadata.execution.mutations.defaults.push(
    ...metadata.execution.mutations.defaults
      .filter((entry) => entry.ref.entry === "projects")
      .map((entry) => ({ ...entry, ref: { ...entry.ref, entry: "notes" } })),
    {
      ref: { namespace: "public", entry: "notes", field: "updated_at" },
      onCreate: { id: "timestampNow", kind: "generator" },
    },
  );
  return {
    directory,
    metadata,
    cleanup: () => {
      // Only the unique fixture created above, inside the known cache directory.
      assert.equal(dirname(directory), cache);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("scaffold previews without writing, preserves source, and refuses a second application", () => {
  const f = fixture();
  try {
    const changes = planFeature(f.directory, f.metadata, choices);
    assert.equal(changes.length, 7);
    assert.equal(
      existsSync(join(f.directory, "packages/database/src/notes.ts")),
      false,
    );
    writeFeature(f.directory, changes);
    const registry = readFileSync(
      join(f.directory, "packages/database/src/index.ts"),
      "utf8",
    );
    assert.match(registry, /users: createUserRepository/);
    assert.match(registry, /projects: createProjectRepository/);
    assert.match(registry, /notes: createNoteRepository/);
    assert.throws(
      () => planFeature(f.directory, f.metadata, choices),
      /already exists|overwrite/,
    );
    assert.throws(
      () => writeFeature(f.directory, changes),
      /changed since preview/,
    );
  } finally {
    f.cleanup();
  }
});

test("scaffold rejects private fields, missing required inputs, unsupported fields, and invalid names", () => {
  const f = fixture();
  try {
    for (const invalid of [
      { publicFields: ["id", "ownerId"] },
      { createFields: ["archived"] },
      { selection: ["createdAt"] },
      { owner: "id" },
      { model: "../Note" },
      { publicFields: ["id", "id"] },
      { mutation: "class" },
    ])
      assert.throws(() =>
        planFeature(f.directory, f.metadata, { ...choices, ...invalid }),
      );
    f.metadata.domain.namespaces.public.models.Note.fields.name.nullable = true;
    assert.throws(
      () => planFeature(f.directory, f.metadata, choices),
      /non-null scalar/,
    );
    assert.equal(
      existsSync(join(f.directory, "packages/database/src/notes.ts")),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("scaffold refuses GraphQL/document collisions and changes made since preview", () => {
  const f = fixture();
  try {
    const collision = join(f.directory, schemaPath, "existing.ts");
    writeFileSync(collision, 'builder.queryField("notes", () => null);');
    assert.throws(
      () => planFeature(f.directory, f.metadata, choices),
      /GraphQL name notes already exists/,
    );
    rmSync(collision);
    const document = join(f.directory, "client-app/src/api/existing.ts");
    mkdirSync(dirname(document), { recursive: true });
    writeFileSync(document, "graphql(`query Notes { otherField }`);");
    assert.throws(
      () => planFeature(f.directory, f.metadata, choices),
      /document Notes already exists/,
    );
    rmSync(document);
    const changes = planFeature(f.directory, f.metadata, choices);
    const registry = join(f.directory, "packages/database/src/index.ts");
    writeFileSync(
      registry,
      readFileSync(registry, "utf8") + "\n// user edit\n",
    );
    assert.throws(
      () => writeFeature(f.directory, changes),
      /changed since preview/,
    );
    assert.equal(
      existsSync(join(f.directory, "packages/database/src/notes.ts")),
      false,
    );
    assert.match(readFileSync(registry, "utf8"), /user edit/);
  } finally {
    f.cleanup();
  }
});

test("a scaffolded feature emits Prisma/GraphQL, compiles, and passes its ownership tests", async () => {
  const f = fixture();
  try {
    const database = join(f.directory, "packages/database");
    // Every repository source, so a new repository or helper needs no edit
    // here. generated/ is a directory, and the fixture emits its own.
    for (const name of readdirSync(join(root, "packages/database/src"))) {
      if (!name.endsWith(".ts")) continue;
      cpSync(
        join(root, "packages/database/src", name),
        join(database, "src", name),
      );
    }
    // Prisma chooses its public import specifiers from the package dependencies.
    cpSync(
      join(root, "packages/database/package.json"),
      join(database, "package.json"),
    );
    const psl = readFileSync(
      join(root, "packages/database/prisma/contract.prisma"),
      "utf8",
    );
    writeFileSync(
      join(database, "contract.prisma"),
      psl + `
model Note {
  id Uuid @id(map: "notes_pkey") @default(uuid())
  ownerId Uuid @map("owner_id")
  owner User @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  name String
  archived Boolean @default(false)
  createdAt TimestamptzString(6) @default(now()) @map("created_at")
  updatedAt temporal.timestamptzString(6, onCreate: now, onUpdate: now) @map("updated_at")
  @@index([ownerId], map: "notes_owner_id_idx")
  @@map("notes")
}
enum Status {
  Draft = "draft"
  Published = "published"
  @@type("pg/text@1")
}
model EnumProbe {
  id Uuid @id @default(uuid())
  status Status
  addedColumn String?
  @@map("enum_probes")
}
`,
    );
    writeFileSync(
      join(database, "prisma.config.ts"),
      `import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-postgres/config";
export default definePrismaConfig({ orm: defineConfig({ contract: "contract.prisma", output: "src/generated" }) });
`,
    );
    const prismaPackage = JSON.parse(
      readFileSync(join(root, "node_modules/prisma/package.json"), "utf8"),
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/prisma", prismaPackage.bin.prisma),
        "contract",
        "emit",
      ],
      {
        cwd: database,
        stdio: "pipe",
        windowsHide: true,
      },
    );
    // The repositories import the generated access settings; emit the
    // fixture's own from its contract, as the package's generate script does.
    const access = readClientAccess(
      readFileSync(join(database, "contract.prisma"), "utf8"),
    );
    assert.deepEqual(access.problems, [], "the fixture contract's @access rules compile");
    writeFileSync(
      join(database, "src/generated/client-access.ts"),
      renderClientAccess(access.settings, access.rows, access.policy),
    );
    const cliArgs = [
      fileURLToPath(import.meta.resolve("aws-studio/cli")),
      "db:scaffold",
      "Note",
      "--public",
      "id,name,archived",
      "--create",
      "name",
      "--owner",
      "ownerId",
      "--query",
      "notes",
      "--mutation",
      "createNote",
      "--select",
      "id,name",
    ];
    const preview = execFileSync(process.execPath, [...cliArgs, "--dry-run"], {
      cwd: f.directory,
      env: { ...process.env, FRAMEWORK_REPOSITORY_ROOT: f.directory },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.match(preview, /Ownership: ownerId from the session user's id/);
    assert.equal(existsSync(join(database, "src/notes.ts")), false);
    execFileSync(process.execPath, [...cliArgs, "--write"], {
      cwd: f.directory,
      env: { ...process.env, FRAMEWORK_REPOSITORY_ROOT: f.directory },
      stdio: "pipe",
      windowsHide: true,
    });
    for (const name of ["builder.ts", "errors.ts"])
      cpSync(join(root, schemaPath, name), join(f.directory, schemaPath, name));
    cpSync(
      join(root, schemaPath, "../graphql-context.ts"),
      join(f.directory, schemaPath, "../graphql-context.ts"),
    );
    // Whatever the context imports from lib/ comes with it.
    cpSync(
      join(root, schemaPath, "../lib"),
      join(f.directory, schemaPath, "../lib"),
      { recursive: true },
    );
    const imported = await import(
      pathToFileURL(join(f.directory, schemaPath, "index.ts")).href
    );
    const generatedPath = join(
      f.directory,
      "client-app/src/api/generated/",
    ).replaceAll("\\", "/");
    // Use the schema builder's own GraphQL installation for Codegen.
    const appRequire = createRequire(join(root, "package.json"));
    const { CodegenContext, generate } = appRequire("@graphql-codegen/cli") as typeof import("@graphql-codegen/cli");
    const codegen: CodegenConfig = {
      cwd: f.directory,
      schema: imported.schema,
      documents: [
        join(f.directory, "client-app/src/api/notes/operations.ts").replaceAll(
          "\\",
          "/",
        ),
      ],
      generates: {
        [generatedPath + "/"]: {
          // The same settings as the repository's codegen.ts.
          preset: "client",
          config: { useTypeImports: true, documentMode: "string" },
          presetConfig: {
            fragmentMasking: false,
            persistedDocuments: { hashAlgorithm: "sha256" },
          },
        },
      },
      silent: true,
    };
    await generate(codegen);
    // Fault injection happens only in this disposable generated fixture.
    const graphqlOutput = join(generatedPath, "graphql.ts");
    const stale =
      readFileSync(graphqlOutput, "utf8") + "\n// simulated stale artifact\n";
    writeFileSync(graphqlOutput, stale);
    const check = new CodegenContext({ config: codegen });
    check.enableCheckMode();
    await generate(check);
    assert.deepEqual(
      check.checkModeStaleFiles.map((name: string) => resolve(name)),
      [resolve(graphqlOutput)],
    );
    assert.equal(
      readFileSync(graphqlOutput, "utf8"),
      stale,
      "--check must not repair or overwrite files",
    );
    const transport = join(f.directory, "client-app/src/api/graphql/client.ts");
    mkdirSync(dirname(transport), { recursive: true });
    cpSync(join(root, "client-app/src/api/graphql/client.ts"), transport);
    const auth = join(f.directory, "client-app/src/lib/auth.ts");
    mkdirSync(dirname(auth), { recursive: true });
    writeFileSync(
      auth,
      'export function frameworkHttpApiFetch(_path: string, _options: RequestInit): Promise<Response> { throw new Error("Fixture never performs network requests"); }',
    );
    const projection = join(database, "src/projection-check.ts");
    writeFileSync(
      projection,
      `import type { ContractRow } from "./contract-types.js";
type Row = ContractRow<"EnumProbe">;
export const valid: Row["status"] = "draft";
export const added: Row["addedColumn"] = null;
// @ts-expect-error The emitted enum must not widen to string.
export const invalid: Row["status"] = "not-a-status";
// @ts-expect-error The newly emitted nullable string must not become a number.
export const invalidColumn: Row["addedColumn"] = 3;
`,
    );
    const program = ts.createProgram(
      [
        join(database, "src/index.ts"),
        projection,
        join(f.directory, schemaPath, "note.ts"),
        join(f.directory, schemaPath, "note.test.ts"),
        join(f.directory, "client-app/src/api/notes/operations.ts"),
      ],
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        paths: {
          "@repo/database": [join(database, "src/index.ts")],
          "@repo/api-contract": [appRequire.resolve("@repo/api-contract")],
          "#/*": [join(f.directory, "client-app/src/*")],
        },
      },
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.file?.fileName}:${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
        )
        .join("\n"),
    );
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        `${schemaPath}/note.test.ts`,
      ],
      {
        // Windows test discovery must not traverse the drive root in Studio's sandbox.
        cwd: f.directory,
        encoding: "utf8",
        windowsHide: true,
        env: childEnvironment,
      },
    );
    assert.match(output, /pass 3/);
  } finally {
    f.cleanup();
  }
});
