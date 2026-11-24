import assert from "./support/assert";
import { test } from "node:test";
import { preserveResourceBuilderComments } from "../server/resource-config-comments";

test("a source value can change without moving argument, metadata or chain comments", () => {
  const before = 'input.value(/* explanation */ "true", { /* metadata */ tags: { area: "realtime" } })\n  /* choices */ .enum("true", "false") /* trailing */';
  const desired = 'input.value("false", { /* metadata */ tags: { area: "realtime" } }).enum("true", "false")';
  assert.equal(preserveResourceBuilderComments(before, desired), before.replace('"true", {', '"false", {'));
});

test("factory changes and mode literals retain the original call trivia", () => {
  const before = 'input.fromEnv(/* authored key */ "OLD_NAME", { tags: { area: "fixture" } }).default(/* fallback */ "before").required(/* graph */ "dev").note("Keep // as literal text")';
  const desired = 'input.fromEnv("OLD_NAME", { tags: { area: "fixture" } }).default("after").required("prod").note("Keep // as literal text")';
  assert.equal(preserveResourceBuilderComments(before, desired), before.replace('"before"', '"after"').replace('"dev"', '"prod"'));
  assert.equal(preserveResourceBuilderComments('input.fromEnv(/* origin */ "OLD_NAME")', 'input.secret("OLD_NAME")'), 'input.secret(/* origin */ "OLD_NAME")');
});

test("new policy calls append while retained calls keep their comment positions", () => {
  const before = 'input.value(/* setting */ "true")\n  // the choices are public\n  .enum("true", "false")';
  assert.equal(preserveResourceBuilderComments(before, 'input.value("true").required().enum("true", "false").note("A note")'), `${before}.required().note("A note")`);
  assert.equal(preserveResourceBuilderComments('input.fromEnv(/* origin */)', 'input.fromEnv("ORIGINAL")'), 'input.fromEnv(/* origin */"ORIGINAL")');
});

test("options can gain a binding pin while keeping their exact authored comments", () => {
  const before = 'input.secret(/* source */ "API_KEY", { /* ownership */ tags: { area: "fixture" } })';
  const desired = 'input.secret("API_KEY", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })';
  assert.equal(preserveResourceBuilderComments(before, desired), 'input.secret(/* source */ "API_KEY", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })');
  assert.equal(preserveResourceBuilderComments('input.secret(/* source */ "API_KEY")', 'input.secret("API_KEY", { bindingPath: ["original"] })'), 'input.secret(/* source */ "API_KEY", { bindingPath: ["original"] })');
  assert.equal(preserveResourceBuilderComments('input.secret("API_KEY", /* option context */)', 'input.secret("API_KEY", { bindingPath: ["original"] })'), 'input.secret("API_KEY", /* option context */ { bindingPath: ["original"] })');
  assert.equal(preserveResourceBuilderComments(before, 'input.value("public", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })'), 'input.value(/* source */ "public", { /* ownership */ tags: { area: "fixture" }, bindingPath: ["original"] })');
});

test("removing calls or arguments refuses any comment inside the discarded span", () => {
  for (const before of ['input.value("true").required(/* graph */ "dev")', 'input.value("true") /* required context */ .required("dev")']) {
    assert.equal(preserveResourceBuilderComments(before, 'input.value("true")'), undefined);
  }
  assert.equal(preserveResourceBuilderComments('input.value(/* setting */ "true").required("dev").note("A note")', 'input.value("true").note("A note")'), 'input.value(/* setting */ "true").note("A note")');
  assert.equal(preserveResourceBuilderComments('input.fromEnv(/* source */ "NAME").required(/* graph */ "dev")', 'input.fromEnv("NAME").required()'), undefined);
  assert.equal(preserveResourceBuilderComments('input.fromEnv(/* source */ "NAME").required("dev")', 'input.fromEnv("NAME").required()'), 'input.fromEnv(/* source */ "NAME").required()');
});

test("per-mode argument replacement refuses lost interior comments and ambiguous chains", () => {
  assert.equal(preserveResourceBuilderComments('input.value({ dev: /* intent */ "true", prod: "false" })', 'input.value({ dev: "false", prod: "false" })'), undefined);
  assert.equal(preserveResourceBuilderComments('input.value({ dev: /* intent */ "true", prod: "false" })', 'input.value({ dev: /* intent */ "false", prod: "false" })'), 'input.value({ dev: /* intent */ "false", prod: "false" })');
  assert.equal(preserveResourceBuilderComments('input.value(/* source */ "true").required("dev").required("prod")', 'input.value("true").required()'), undefined);
  assert.equal(preserveResourceBuilderComments('input.value(/* source */ "true"); other()', 'input.value("true")'), undefined);
});
