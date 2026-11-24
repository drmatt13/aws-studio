import { installFixtureRelease } from "./support/project-cli";
import assert from "./support/assert";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import test from "node:test";
import { FrontendReleaseService, frontendSettings, frontendPath } from "../server/frontend-release";
import { DeploymentIdentityService } from "../server/deployment-identities";
import { runCommand } from "../server/deploy/process";
import { DEFAULT_FRONTEND_RELEASE, type FrontendReleaseSettings } from "../shared/frontend-release";
import { defaults } from "../../scripts/test-project-declarations";

const repository = path.resolve(__dirname, "../..");
const cache = path.join(repository, ".cache/frontend-release-tests"); mkdirSync(cache, { recursive: true });
const account = "111122223333"; const region = "us-east-1";
const storedObject = (body: string) => ({ body, ETag: JSON.stringify(createHash("md5").update(body).digest("hex")) });
function fixture(mode: "dev" | "prod" = "prod") {
  const root = mkdtempSync(path.join(cache, "case-"));
  // Output ownership must be established inside this disposable repository,
  // including source-only verification copies without an enclosing .git.
  execFileSync("git", ["init", "--quiet", root], { stdio: "pipe" });
  for (const directory of ["cdk-app", "framework-config", "scripts", "web"]) mkdirSync(path.join(root, directory));
  mkdirSync(path.join(root, "framework-config/deployment"));
  writeFileSync(path.join(root, "package.json"), '{"private":true}');
  installFixtureRelease(root);
  writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:app": "fixture", "framework:appId": "0f9c2d1e-7b3a-4c5d-9e8f-1a2b3c4d5e6f", "framework:targets": { [mode]: { mode, account, region, inputs: "cdk-app/.env.staging", deployAs: `fixture-${mode}` } } } }));
  writeFileSync(path.join(root, "cdk-app/.env.staging"), `PUBLIC_SETTING=public-from-target\nPRIVATE_SECRET=never-leak-secret\n`);
  writeFileSync(path.join(root, "cdk-app/.env.prod"), "PUBLIC_SETTING=wrong-conventional-file\n");
  writeFileSync(path.join(root, "cdk-app/.env.dev"), "PUBLIC_SETTING=wrong-development-file\nSECRET=preserve-me\n# human comment\n");
  writeFileSync(path.join(root, "cdk-app/.env.dev.template"), "PUBLIC_SETTING=template-dev\n");
  writeFileSync(path.join(root, "cdk-app/.env.prod.template"), "PUBLIC_SETTING=template-prod\n");
  const binding = { kind: "input", name: "PUBLIC_SETTING" };
  writeFileSync(path.join(root, "framework.config.ts"), `import { defineFrameworkConfig, defineInputs, input } from "aws-studio/config"; export default defineFrameworkConfig({ defaults: ${JSON.stringify(defaults)}, http: [], webSocket: [], events: [], services: [], inputs: defineInputs({ publicSetting: input.fromEnv("PUBLIC_SETTING"), privateSecret: input.secret("PRIVATE_SECRET") }) });`);
  writeFileSync(path.join(root, "framework-config/client-environment.ts"), `export const clientEnvironment = ${JSON.stringify({ VITE_PUBLIC: { dev: binding, prod: binding } })} as const;`);
  const settings = { ...DEFAULT_FRONTEND_RELEASE, projectDirectory: "web", prefix: "app/" };
  writeFileSync(path.join(root, "framework-config/deployment/frontend-release.json"), JSON.stringify(settings));
  writeFileSync(path.join(root, "web/package.json"), JSON.stringify({ private: true, scripts: { build: "node build.mjs" } }));
  writeFileSync(path.join(root, "web/build.mjs"), `import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const env=readFileSync('.env.${mode === "prod" ? "production" : "development"}.local','utf8');
if(!env.includes('public-from-target')||env.includes('never-leak-secret'))throw new Error('wrong public env');
mkdirSync('dist/assets',{recursive:true});writeFileSync('dist/assets/app.js','console.log("fixture")');writeFileSync('dist/index.html','<!doctype html><title>Alternate frontend</title>');writeFileSync('dist/.env.secret','never-publish');writeFileSync('dist/assets/app.js.map','never-publish-map');`);
  const identity = { version: 1, deployment: `fixture-${mode}`, mode, account, region };
  const stack = { StackName: `${identity.deployment}-FrontendWebsiteS3Stack`, StackId: `arn:aws:cloudformation:${region}:${account}:stack/${identity.deployment}-FrontendWebsiteS3Stack/id`, StackStatus: "UPDATE_COMPLETE", Outputs: [
    { Description: "framework:deployment:v1", OutputValue: JSON.stringify(identity) },
    { OutputKey: "FrontendWebsiteBucketName", OutputValue: "fixture-owned-website" }, { OutputKey: "CloudFrontId", OutputValue: "EFIXTURE1234" }, { OutputKey: "CloudFrontUrl", OutputValue: "https://127.0.0.1:1" },
  ] };
  const state = path.join(root, "aws-state.json"); writeFileSync(state, JSON.stringify({ account, stack, failInvalidation: false, calls: [], objects: { "app/old.js": storedObject("old dependency"), "unrelated/keep": storedObject("keep") }, invalidations: {} }));
  const fake = path.join(root, "fake-aws.mjs");
  writeFileSync(fake, `import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const file=process.env.RELEASE_FAKE_STATE;const state=JSON.parse(readFileSync(file,'utf8'));const args=process.argv.slice(2);state.calls.push(args);writeFileSync(file,JSON.stringify(state));
const send=x=>console.log(JSON.stringify(x));const key=args.slice(0,2).join(' ');
const option=name=>args[args.indexOf(name)+1];const save=()=>writeFileSync(file,JSON.stringify(state));
const refuse=message=>{console.error(message);process.exit(1)};
if(args.includes('--expected-bucket-owner')&&option('--expected-bucket-owner')!==state.account)refuse('wrong bucket owner');
if(key==='sts get-caller-identity')send({Account:state.account,Arn:state.actorArn??'arn:aws:iam::111122223333:user/fixture'});
else if(key==='cloudformation describe-stacks')send({Stacks:[state.stack]});
else if(key==='cloudformation list-stack-resources')send({StackResourceSummaries:[{ResourceType:'AWS::S3::Bucket',PhysicalResourceId:'fixture-owned-website'},{ResourceType:'AWS::CloudFront::Distribution',PhysicalResourceId:'EFIXTURE1234'}]});
else if(key==='s3api head-bucket')send({});
else if(key==='cloudfront get-distribution')send({ETag:'fixture-etag',Distribution:{ARN:'arn:aws:cloudfront::111122223333:distribution/EFIXTURE1234',DistributionConfig:{Enabled:true,Origins:{Items:[{DomainName:state.origin??'fixture-owned-website.s3.us-east-1.amazonaws.com'}]}}}});
else if(key==='s3api list-objects-v2')send({Contents:Object.entries(state.objects).filter(([name])=>name.startsWith(option('--prefix'))).map(([Key,value])=>({Key,ETag:value.ETag}))});
else if(key==='s3api put-object'){
  const body=readFileSync(option('--body'));
  if(option('--checksum-algorithm')!=='SHA256'||option('--checksum-sha256')!==createHash('sha256').update(body).digest('base64'))refuse('checksum mismatch');
  const ETag=JSON.stringify(createHash('md5').update(body).digest('hex'));
  state.objects[option('--key')]={body:body.toString('utf8'),ETag};save();send({ETag});
}
else if(key==='s3api delete-object'){
  const name=option('--key');
  if(state.failDeleteKey===name){delete state.failDeleteKey;save();refuse('injected deletion failure before effect')}
  if(state.objects[name]&&option('--if-match')!==state.objects[name].ETag)refuse('ETag mismatch');
  delete state.objects[name];save();send({});
}
else if(key==='cloudfront create-invalidation'){
  if(state.failInvalidation)refuse('injected failure');
  const batch=JSON.parse(option('--invalidation-batch'));const previous=state.invalidations[batch.CallerReference];
  if(previous&&JSON.stringify(previous.batch)!==JSON.stringify(batch))refuse('idempotency token reused with another batch');
  const invalidation=previous??{batch,Id:'I'+Object.keys(state.invalidations).length};state.invalidations[batch.CallerReference]=invalidation;save();
  send({Invalidation:{Id:invalidation.Id,Status:'InProgress'}});
}
else{console.error('unsupported fake command '+key);process.exit(2)}`);
  const service = new FrontendReleaseService(root, { run: async (spec, options) => {
    const result = await runCommand(spec, options);
    if (spec.args.includes("export:cdk-outputs")) assert.equal(result.code, 0, result.stderr);
    return result;
  }, env: { ...process.env, npm_config_workspaces: "true", npm_config_if_present: "true", FRAMEWORK_INPUTS_FILE: undefined, FRAMEWORK_AWS_CLI: fake, RELEASE_FAKE_STATE: state, AWS_PROFILE: "should-be-replaced" } });
  return { root, service, state, input: { deployment: identity.deployment, profile: "dev", region }, settings,
    load: () => JSON.parse(readFileSync(state, "utf8")), save: (value: any) => writeFileSync(state, JSON.stringify(value)),
    buildFiles: (files: Record<string, string>) => {
      const excluded = path.join(root, "web/dist/.env.secret"); if (existsSync(excluded)) rmSync(excluded);
      writeFileSync(path.join(root, "web/build.mjs"), `import {mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';
for(const [name,body] of Object.entries(${JSON.stringify(files)})){const file=path.join('dist',name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body);}`);
    },
    cleanup: () => { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); } };
}

test("real public client export uses the named target inputs without Docker or control outputs", async () => {
  for (const mode of ["dev", "prod"] as const) {
    const fixtureCase = fixture(mode);
    try {
      const profile = "team developer";
      const generated = await fixtureCase.service.generateEnvironment({ ...fixtureCase.input, profile });
      assert.equal(generated.destination.profile, profile);
      assert.ok(fixtureCase.load().calls.every((args: string[]) => args[args.indexOf("--profile") + 1] === profile), "the full existing profile name remains one argv value");
      const contents = readFileSync(path.join(fixtureCase.root, generated.file), "utf8");
      assert.equal(parseEnv(contents).VITE_PUBLIC, "public-from-target");
      assert.doesNotMatch(contents, /never-leak-secret|wrong-conventional|wrong-development/);
      assert.equal(existsSync(path.join(fixtureCase.root, ".env")), false);
      assert.equal(existsSync(path.join(fixtureCase.root, ".framework/local/resources.json")), false);
      assert.ok(fixtureCase.load().calls.every((args: string[]) => !["s3", "cloudfront", "docker"].includes(args[0]!)));
    } finally { fixtureCase.cleanup(); }
  }
});

test("a changed AWS principal invalidates publication even in the same account", async () => {
  const f = fixture();
  try {
    const review = await f.service.build(f.input);
    const state = f.load(); state.actorArn = `arn:aws:iam::${account}:user/another-user`; f.save(state);
    await assert.rejects(f.service.publish(review.id, `Publish ${f.input.deployment} to fixture-owned-website`), /changed.*nothing was published/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)), "identity changes refuse every publication effect");
  } finally { f.cleanup(); }
});

test("alternate frontend builds fresh, excludes secrets/maps, binds approval and retries failed invalidation", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, "web/dist")); writeFileSync(path.join(f.root, "web/dist/stale.html"), "old artifact");
    const current = f.service.settings(); const settingsReview = f.service.settingsReview({ ...f.settings, deleteRemote: true }, current.hash);
    assert.equal(readFileSync(path.join(f.root, "framework-config/deployment/frontend-release.json"), "utf8"), JSON.stringify(f.settings), "settings review does not write");
    f.service.settingsApply(settingsReview.id);
    const review = await f.service.build(f.input);
    assert.deepEqual(review.files.map(file => file.path), ["assets/app.js", "index.html"]);
    assert.deepEqual(review.deleteKeys, ["app/old.js"]);
    assert.ok(existsSync(path.join(f.root, ".cache/framework-studio/frontend-releases", review.id, "previous-output/stale.html")));
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)), "build never publishes");
    await assert.rejects(f.service.publish(review.id, "Publish wrong bucket"), /exact.*approval/);
    const state = f.load(); state.failInvalidation = true; f.save(state);
    const approval = `Publish ${f.input.deployment} to fixture-owned-website`;
    await assert.rejects(f.service.publish(review.id, approval), /No automatic rollback/);
    assert.equal(f.service.result(review.id).phase, "failed");
    assert.equal(f.service.result(review.id).uploaded.length, 2);
    const afterFailure = f.load(); afterFailure.failInvalidation = false; f.save(afterFailure);
    const result = await f.service.publish(review.id, approval);
    assert.equal(result.phase, "complete"); assert.equal(result.invalidationStatus, "InProgress");
    assert.match(result.message, /cache completion need separate verification/);
    const calls = f.load().calls as string[][];
    assert.equal(calls.filter(args => args[1] === "put-object").length, 2, "retry skips confirmed uploads");
    assert.ok(calls.filter(args => args[1] === "put-object").every(args => args[args.indexOf("--expected-bucket-owner") + 1] === account), "every upload pins bucket owner");
    assert.ok(calls.filter(args => args[1] === "put-object").every(args => args.includes("--checksum-sha256")), "S3 validates exact reviewed bytes even if a staged file changes during transport");
    const invalidations = calls.filter(args => args[1] === "create-invalidation");
    assert.equal(invalidations.length, 2); assert.equal(invalidations[0]![invalidationIndex(invalidations[0]!)], invalidations[1]![invalidationIndex(invalidations[1]!)], "retry preserves idempotency token");
    assert.ok(calls.findIndex(args => args[1] === "create-invalidation") > calls.findIndex(args => args[1] === "delete-object"));
    assert.ok(!JSON.stringify(review).includes("never-leak-secret"));
    await assert.rejects(f.service.publish(review.id, approval), /complete/);
  } finally { f.cleanup(); }
});
const invalidationIndex = (args: string[]) => args.indexOf("--invalidation-batch") + 1;

const publicationCalls = (state: { calls: string[][] }) =>
  state.calls.filter(args => ["put-object", "delete-object", "create-invalidation"].includes(args[1]!));

for (const [label, firstPrefix, nextPrefix] of [
  ["equal", "app/", "app/"],
  ["descendant", "app/", "app/nested/"],
  ["ancestor", "app/nested/", "app/"],
  ["bucket root", "app/", ""],
] as const) {
  test(`an intervening publication supersedes failed recovery for ${label} prefixes`, async () => {
    const f = fixture();
    try {
      const key = `${firstPrefix.length >= nextPrefix.length ? firstPrefix : nextPrefix}old.js`;
      const dependency = storedObject('console.log("shared dependency")');
      const state = f.load(); state.objects = { [key]: dependency }; state.failDeleteKey = key; f.save(state);
      const settingsA = { ...f.settings, prefix: firstPrefix, deleteRemote: true };
      const settingsB = { ...settingsA, prefix: nextPrefix };
      const applySettings = (settings: FrontendReleaseSettings) => f.service.settingsApply(f.service.settingsReview(settings, f.service.settings().hash).id);
      applySettings(settingsA);
      const a = await f.service.build(f.input);
      assert.deepEqual(a.deleteKeys, [key]);
      const approval = `Publish ${f.input.deployment} to fixture-owned-website`;
      await assert.rejects(f.service.publish(a.id, approval), /No automatic rollback/);
      assert.equal(f.service.result(a.id).phase, "failed");
      assert.deepEqual(f.service.result(a.id).uploaded, a.files.map(file => file.path));
      assert.deepEqual(f.service.result(a.id).deleted, [], "A failed before the deletion took effect");
      assert.deepEqual(f.load().objects[key], dependency);

      const relativeDependency = key.slice(nextPrefix.length);
      const html = `<!doctype html><script src="${relativeDependency}"></script>`;
      f.buildFiles({ [relativeDependency]: dependency.body, "index.html": html });
      applySettings(settingsB);
      const b = await f.service.build(f.input);
      assert.equal((await f.service.publish(b.id, approval)).phase, "complete");
      assert.deepEqual(f.load().objects[key], dependency, "B retains exactly the ETag reviewed by A");
      // Restore A's settings bytes so the regression exercises publication authority,
      // independently of the pre-existing settings fingerprint check.
      applySettings(settingsA);
      const before = f.load();
      await assert.rejects(f.service.publish(a.id, approval), /superseded/);
      const after = f.load();
      assert.deepEqual(publicationCalls(after), publicationCalls(before), "stale recovery causes no PUT, DELETE or invalidation");
      assert.deepEqual(after.objects, before.objects);
      assert.equal(after.objects[`${nextPrefix}index.html`].body, html);
      assert.deepEqual(after.objects[key], dependency);
    } finally { f.cleanup(); }
  });
}

test("a disjoint publication does not supersede failed invalidation recovery", async () => {
  const f = fixture();
  try {
    const approval = `Publish ${f.input.deployment} to fixture-owned-website`;
    const a = await f.service.build(f.input);
    const state = f.load(); state.failInvalidation = true; f.save(state);
    await assert.rejects(f.service.publish(a.id, approval), /No automatic rollback/);
    const failed = f.load(); failed.failInvalidation = false; f.save(failed);
    f.buildFiles({ "index.html": "<!doctype html><title>Separate publication</title>" });
    const other = { ...f.settings, prefix: "application/" };
    f.service.settingsApply(f.service.settingsReview(other, f.service.settings().hash).id);
    const b = await f.service.build(f.input);
    assert.equal((await f.service.publish(b.id, approval)).phase, "complete");
    // A was built with compact fixture settings; restore those exact bytes.
    writeFileSync(path.join(f.root, "framework-config/deployment/frontend-release.json"), JSON.stringify(f.settings));
    const before = f.load();
    assert.equal((await f.service.publish(a.id, approval)).phase, "complete");
    const after = f.load();
    assert.deepEqual(after.objects, before.objects, "resumption preserves both disjoint publications");
    assert.equal(publicationCalls(after).filter(args => args[1] === "put-object").length, publicationCalls(before).filter(args => args[1] === "put-object").length);
  } finally { f.cleanup(); }
});

test("building or refusing a newer review does not supersede resumable publication", async () => {
  const f = fixture();
  try {
    const approval = `Publish ${f.input.deployment} to fixture-owned-website`;
    const a = await f.service.build(f.input);
    const state = f.load(); state.failInvalidation = true; f.save(state);
    await assert.rejects(f.service.publish(a.id, approval), /No automatic rollback/);
    const failed = f.load(); failed.failInvalidation = false; f.save(failed);
    f.buildFiles({ "index.html": "<!doctype html><title>Not published</title>" });
    const b = await f.service.build(f.input);
    await assert.rejects(f.service.publish(b.id, "wrong approval"), /exact.*approval/);
    writeFileSync(path.join(f.root, ".cache/framework-studio/frontend-releases", b.id, "assets/index.html"), "changed staged artifact");
    await assert.rejects(f.service.publish(b.id, approval), /artifact changed/);
    const before = f.load();
    assert.equal((await f.service.publish(a.id, approval)).phase, "complete");
    assert.deepEqual(f.load().objects, before.objects);
  } finally { f.cleanup(); }
});

test("an intervening failed publication supersedes old recovery and remains resumable itself", async () => {
  const f = fixture();
  try {
    const approval = `Publish ${f.input.deployment} to fixture-owned-website`;
    const a = await f.service.build(f.input);
    const state = f.load(); state.failInvalidation = true; f.save(state);
    await assert.rejects(f.service.publish(a.id, approval), /No automatic rollback/);
    f.buildFiles({ "index.html": "<!doctype html><title>Latest attempted publication</title>" });
    const b = await f.service.build(f.input);
    await assert.rejects(f.service.publish(b.id, approval), /No automatic rollback/);
    const before = f.load();
    await assert.rejects(f.service.publish(a.id, approval), /superseded/);
    assert.deepEqual(publicationCalls(f.load()), publicationCalls(before));
    before.failInvalidation = false; f.save(before);
    assert.equal((await f.service.publish(b.id, approval)).phase, "complete");
    assert.deepEqual(f.load().objects, before.objects);
  } finally { f.cleanup(); }
});

test("a changed remote ETag refuses deletion and dependent invalidation", async () => {
  const f = fixture();
  try {
    f.service.settingsApply(f.service.settingsReview({ ...f.settings, deleteRemote: true }, f.service.settings().hash).id);
    const review = await f.service.build(f.input);
    const state = f.load(); state.objects["app/old.js"] = storedObject("changed since review"); f.save(state);
    await assert.rejects(f.service.publish(review.id, `Publish ${f.input.deployment} to fixture-owned-website`), /No automatic rollback/);
    const after = f.load();
    assert.deepEqual(after.objects["app/old.js"], state.objects["app/old.js"]);
    assert.deepEqual(f.service.result(review.id).deleted, []);
    assert.equal(publicationCalls(after).filter(args => args[1] === "create-invalidation").length, 0);
  } finally { f.cleanup(); }
});

test("release refuses changed account, output identity, artifact bytes and no-op builds", async () => {
  const f = fixture();
  try {
    const state = f.load(); state.account = "999988887777"; f.save(state);
    await assert.rejects(f.service.generateEnvironment(f.input), /profile\/account\/region/);
    state.account = account; f.save(state);
    const review = await f.service.build(f.input);
    const staged = path.join(f.root, ".cache/framework-studio/frontend-releases", review.id, "assets/index.html");
    writeFileSync(staged, "changed");
    await assert.rejects(f.service.publish(review.id, `Publish ${f.input.deployment} to fixture-owned-website`), /artifact changed/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)));
    writeFileSync(path.join(f.root, "web/build.mjs"), "console.log('no output');");
    rmSync(path.join(f.root, "web/dist/.env.secret"));
    await assert.rejects(f.service.build(f.input), /without producing/);
    assert.throws(() => frontendSettings({ ...f.settings, outputDirectory: "../outside" }), /relative path/);
    assert.throws(() => frontendPath(f.root, "../outside"), /relative path/);
  } finally { f.cleanup(); }
});

test("source folders and changed public input sources are refused before publication", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, "web/src")); writeFileSync(path.join(f.root, "web/src/main.ts"), "keep-source");
    const current = f.service.settings();
    assert.throws(() => f.service.settingsReview({ ...f.settings, outputDirectory: "src" }, current.hash), /generated build output folder/);
    assert.equal(f.service.settings().hash, current.hash, "an invalid output is rejected before saving or reading AWS");
    assert.equal(f.load().calls.length, 0);
    assert.equal(readFileSync(path.join(f.root, "web/src/main.ts"), "utf8"), "keep-source");
    const safe = f.service.settingsReview(f.settings, f.service.settings().hash); f.service.settingsApply(safe.id);
    const review = await f.service.build(f.input);
    writeFileSync(path.join(f.root, "cdk-app/.env.staging"), "PUBLIC_SETTING=changed-after-build\n");
    await assert.rejects(f.service.publish(review.id, `Publish ${f.input.deployment} to fixture-owned-website`), /mapping\/input sources/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)));
    const restarted = new FrontendReleaseService(f.root);
    assert.equal(restarted.result(review.id).phase, "failed", "durable results survive service restart");
    writeFileSync(path.join(f.root, ".cache/framework-studio/frontend-releases", review.id, "result.json"), "{broken");
    assert.throws(() => restarted.history(), /effects are unknown/);
  } finally { f.cleanup(); }
});

test("website output ownership and actual distribution origin are verified before builds or publication", async () => {
  const f = fixture();
  try {
    const state = f.load(); const bucket = state.stack.Outputs.find((output: any) => output.OutputKey === "FrontendWebsiteBucketName"); bucket.OutputValue = "unowned-other-bucket"; f.save(state);
    await assert.rejects(f.service.build(f.input), /not the bucket and distribution owned/);
    bucket.OutputValue = "fixture-owned-website"; state.origin = "unrelated-bucket.s3.us-east-1.amazonaws.com"; f.save(state);
    await assert.rejects(f.service.build(f.input), /no S3 origin for the reviewed bucket/);
    assert.ok(f.load().calls.every((args: string[]) => !["put-object", "delete-object", "create-invalidation"].includes(args[1]!)));
  } finally { f.cleanup(); }
});

test("a new stage is added under framework:targets as <app>-<stage>, leaving every other stage and inputs file alone", () => {
  const f = fixture();
  try {
    const service = new DeploymentIdentityService(f.root);
    const beforeDev = readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8");
    const beforeProd = readFileSync(path.join(f.root, "cdk-app/.env.prod"), "utf8");
    const original = JSON.parse(readFileSync(path.join(f.root, "cdk-app/cdk.json"), "utf8"));
    const review = service.review({ stage: "staging", mode: "prod", account, region }, service.load().hash);
    assert.equal(review.name, "fixture-staging");
    assert.doesNotMatch(JSON.stringify(review), /preserve-me|never-leak-secret/);
    assert.throws(() => service.review({ stage: "qa", mode: "prod", region }, service.load().hash), /needs its account/);
    assert.throws(() => service.review({ stage: "Bad Stage", mode: "dev" }, service.load().hash), /lowercase letters/);
    service.apply(review.id);
    const targets = JSON.parse(readFileSync(path.join(f.root, "cdk-app/cdk.json"), "utf8")).context["framework:targets"];
    assert.deepEqual(targets.prod, original.context["framework:targets"].prod, "the existing stage keeps its pinned name");
    assert.deepEqual(targets.staging, { mode: "prod", account, region, inputs: "cdk-app/.env.prod" });
    assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8"), beforeDev);
    assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.prod"), "utf8"), beforeProd);
    assert.throws(() => service.review({ stage: "staging", mode: "prod", account, region }, service.load().hash), /already exists/);
    const development = service.review({ stage: "qa", mode: "dev" }, service.load().hash);
    assert.equal(development.name, "fixture-qa");
    writeFileSync(path.join(f.root, "cdk-app/cdk.json"), readFileSync(path.join(f.root, "cdk-app/cdk.json"), "utf8") + " ");
    assert.throws(() => service.apply(development.id), /Nothing was written/);
    writeFileSync(path.join(f.root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:targets": original.context["framework:targets"] } }));
    assert.throws(() => service.review({ stage: "qa", mode: "dev" }, service.load().hash), /Name this app in the navbar/);
  } finally { f.cleanup(); }
});
