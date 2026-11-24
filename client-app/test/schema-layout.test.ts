import assert from "./support/assert";
import { test } from "node:test";
import { parseDeclaredSchema } from "../server/database";
import { schemaLayout, TABLE_WIDTH } from "../src/schema-layout";

const schema = parseDeclaredSchema(`
model Account {
  id Uuid @id
}
model Membership {
  id Uuid @id
  accountId Uuid
  account Account @relation(fields: [accountId], references: [id])
}
model Invitation {
  id Uuid @id
  accountId Uuid
  account Account @relation(fields: [accountId], references: [id])
}
model Document {
  id Uuid @id
  parentId Uuid?
  parent Document? @relation(fields: [parentId], references: [id])
}
model Chunk {
  id Uuid @id
  documentId Uuid
  document Document @relation(fields: [documentId], references: [id])
}
model Unconnected {
  id Uuid @id
}
`);

test("schema neighborhoods follow relationships and remain stable when declarations are reordered", () => {
  const layout = schemaLayout(schema);
  assert.deepEqual(schemaLayout({ ...schema, tables: [...schema.tables].reverse(), relations: [...schema.relations].reverse() }), layout);
  const groupFor = (name: string) => layout.groups.find(group => group.tables.some(entry => entry.table.model === name));
  assert.equal(groupFor("Account"), groupFor("Membership"));
  assert.equal(groupFor("Account"), groupFor("Invitation"));
  assert.equal(groupFor("Document"), groupFor("Chunk"));
  assert.notEqual(groupFor("Account"), groupFor("Document"));
  assert.equal(groupFor("Unconnected")?.tables.length, 1);
  assert.equal(layout.edges.length, schema.relations.length, "self references remain navigable");
});

test("variable-height cards and neighborhoods never overlap or escape the fitted bounds", () => {
  const varied = { ...schema, tables: schema.tables.map((table, index) => ({ ...table,
    columns: Array.from({ length: index * 13 + 1 }, (_, column) => ({ ...table.columns[0]!, name: column ? `field${column}` : "id" })),
  })) };
  for (const aspect of [0.3, 0.8, 1.5, 3]) {
    const layout = schemaLayout(varied, aspect);
    assert.equal(layout.tables.length, varied.tables.length);
    for (const [index, entry] of layout.tables.entries()) {
      assert.ok(entry.x >= 0 && entry.y >= 0);
      assert.ok(entry.x + TABLE_WIDTH <= layout.width);
      assert.ok(entry.y + entry.height <= layout.height);
      for (const other of layout.tables.slice(index + 1)) {
        assert.ok(entry.x + TABLE_WIDTH <= other.x || other.x + TABLE_WIDTH <= entry.x
          || entry.y + entry.height <= other.y || other.y + other.height <= entry.y);
      }
    }
    for (const edge of layout.edges) assert.ok(!/NaN|Infinity/.test(edge.path));
  }
  const narrow = schemaLayout(varied, 0.3), wide = schemaLayout(varied, 3);
  assert.ok(wide.width / wide.height > narrow.width / narrow.height);
  const empty = schemaLayout({ ...schema, tables: [], relations: [] });
  assert.deepEqual(empty.tables, []);
  assert.ok(Number.isFinite(empty.width) && Number.isFinite(empty.height));
});
