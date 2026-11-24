import assert from "./support/assert";
import test from "node:test";
import ts from "typescript";
import { isDeployConditionExpression, parse } from "../server/source/syntax";

test("input and stack catalog aliases retain editable deployment conditions after the catalog migration", () => {
  const editable = (imports: string, expression: string) => {
    const source = parse("workload.ts", `${imports}\nconst condition = ${expression};`);
    const declaration = source.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!;
    return isDeployConditionExpression(declaration.initializer!);
  };
  for (const exported of ["inputs", "stacks", "resources"]) assert.equal(editable(`import { ${exported} as catalog } from "./framework-config/catalog";`, '{when:{resource:catalog.flag,equals:"enabled"}}'), true, exported);
  assert.equal(editable('import type { inputs } from "./framework-config/inputs";', '{when:{resource:inputs.flag,equals:"enabled"}}'), false);
  assert.equal(editable('import { inputs } from "./framework-config/inputs";', '{when:{resource:choose(inputs.flag),equals:"enabled"}}'), false);
});
