import assert from "./support/assert";
import { test } from "node:test";
import { parseDeclaredSchema, type DeclaredPrismaReview } from "../server/database";
import { diffPrisma } from "aws-studio/contract-chain/core";

const source = `enum Rank {
  /// @access(...READER, edit)
  LEAD = "LEAD"
  /// @access(read)
  READER = "READER"
}
/// @access(read, update: id == auth.id)
model User {
  id String @id
  name String
  rank Rank
  groups Group[]
}
/// @access(read: personId == auth.id)
model Group {
  id String @id
  personId String
  person User @relation(fields: [personId], references: [id])
}
`;
function review(text: string) {
  let captured: DeclaredPrismaReview | undefined;
  parseDeclaredSchema(text, "contract.prisma", (value) => { captured = value; });
  assert.deepEqual(captured?.diagnostics, []);
  return captured!.models;
}
test("role abilities and model rules change contract review independently of storage", () => {
  const before = review(source);
  const differences = diffPrisma(before, review(source.replace("/// @access(read)\n  READER", "/// @access(read, edit)\n  READER").replace("read, update: id == auth.id", "read: id == auth.id")));
  assert.equal(differences.length, 2);
  assert.match(JSON.stringify(differences), /access policies/);
  assert.match(JSON.stringify(differences), /enum Rank access/);
  assert.deepEqual(diffPrisma(before, review(source.replace("/// @access(...READER, edit)", "/// @access( ...READER,edit )"))), [], "spacing is not a policy change");
});
