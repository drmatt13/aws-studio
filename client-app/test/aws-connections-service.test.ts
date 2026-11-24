import assert from "./support/assert";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { classifyAwsConnectionError, loadAwsCatalog, AwsConnectionError, problem } from "aws-studio/cli/aws-connections";
import { AuthenticationCoordinator, runAuthenticationCommand, safeAuthorizationUrl, type AuthRunner } from "../server/aws-connections/authentication";
import { patchIniSection } from "../server/aws-connections/configuration";
import { AwsConnectionsService } from "../server/aws-connections/service";
import type { AwsAuthenticationSession, AwsCliCapabilities } from "../shared/aws-connection-management";

const capabilities: AwsCliCapabilities = { available: true, version: "2.34.54", credentialExport: true, modernSso: true, pkce: true, consoleLogin: true };
const directories: string[] = [];
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(config = "[profile base]\nregion=us-east-1\n") {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio connection service Δ-")); directories.push(directory);
  const configFile = path.join(directory, "config"), credentialsFile = path.join(directory, "credentials");
  writeFileSync(configFile, config, { mode: 0o600 }); writeFileSync(credentialsFile, "[base]\naws_access_key_id=SENTINEL_KEY\naws_secret_access_key=SENTINEL_SECRET\n", { mode: 0o600 });
  return { directory, configFile, credentialsFile, env: { HOME: directory, USERPROFILE: directory, AWS_LOGIN_CACHE_DIRECTORY: path.join(directory, "login-cache"), AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile } };
}
async function terminal(coordinator: AuthenticationCoordinator, id: string): Promise<AwsAuthenticationSession> {
  for (let attempt = 0; attempt < 100; attempt++) { const view = coordinator.get(id); if (["complete", "failed", "canceled", "confirmation-required"].includes(view.state)) return view; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Authentication fixture did not reach its expected state");
}
test("catalog performs metadata discovery and a capability probe, never credential resolution", async () => {
  const f = fixture(); const calls: readonly string[][] = [];
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async args => { (calls as string[][]).push([...args]); return { stdout: "aws-cli/2.34.54 Python/3.14", stderr: "", code: 0 }; } }); disposers.push(() => service.dispose());
  const catalog = await service.catalog();
  assert.deepEqual(calls, [["--version"]]); assert.equal(catalog.capabilities.consoleLogin, true);
  assert.doesNotMatch(JSON.stringify(catalog), /SENTINEL/);
});
// Verbatim from AWS CLI 2.34.54: botocore's LoginError family and LoginCredentialFetcher.
const consoleSessionFailures = [
  "aws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'.",
  "aws: [ERROR]: Unable to refresh login credentials because of a change in your password. Please reauthenticate with your new password using 'aws login'.",
  "aws: [ERROR]: Unable to create or refresh login credentials due to insufficient permissions. You may be missing permission for the 'signin:CreateOAuth2Token' action.",
  "aws: [ERROR]: Error loading login session token: Unable to load a existing login session for session arn:aws:iam::123456789012:root, Please reauthenticate with 'aws login'.",
  "aws: [ERROR]: Error loading login session token: Failed to load access token from token cache, missing one or more required fields.",
  "aws: [ERROR]: Error loading login session token: Failed to refresh an access token.",
  "aws: [ERROR]: Error loading login session token: Private key not found in cached token.",
  "aws: [ERROR]: An unspecified error happened when resolving AWS credentials or refreshing a login session profile.",
];
for (const stderr of consoleSessionFailures) test(`a Console session failure asks for sign-in: ${stderr.slice(14, 70)}`, () => {
  assert.equal(classifyAwsConnectionError(stderr).code, "expired");
});
test("classifying Console session failures leaves neighbouring failures alone", () => {
  assert.equal(classifyAwsConnectionError("No login session is configured for this profile").code, "no-credentials");
  assert.equal(classifyAwsConnectionError("Could not connect to the endpoint URL: \"https://signin.us-east-1.amazonaws.com/\"").code, "network");
  assert.equal(classifyAwsConnectionError("An error occurred (AccessDenied) when calling the GetCallerIdentity operation").code, "denied");
  assert.equal(classifyAwsConnectionError("Something this Studio has never seen").code, "failed");
});
test("an expired Console session reports sign-in required and keeps the last verified identity", async () => {
  const f = fixture(); let expired = false;
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async () => { if (expired) throw new AwsConnectionError(classifyAwsConnectionError(consoleSessionFailures[0]!)); return { stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:root" }), stderr: "", code: 0 }; } }); disposers.push(() => service.dispose());
  await service.check("base", true);
  expired = true; const observation = await service.check("base", true);
  assert.equal(observation.state, "needs-auth"); assert.equal(observation.problem?.action, "connect"); assert.equal(observation.lastKnownIdentity?.arn, "arn:aws:iam::123456789012:root");
});
test("identity checks coalesce, keep role summaries and preserve stale identity on classified network failure", async () => {
  const f = fixture(); let calls = 0; let fail = false;
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); if (fail) throw new AwsConnectionError(problem("network")); return { stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:sts::123456789012:assumed-role/Admin/session-name" }), stderr: "", code: 0 }; } }); disposers.push(() => service.dispose());
  const [one, two] = await Promise.all([service.check("base"), service.check("base")]);
  assert.deepEqual(one, two); assert.equal(calls, 1); assert.equal(one.identity?.summary, "Admin / session-name");
  await service.check("base"); assert.equal(calls, 1);
  fail = true; const stale = await service.check("base", true);
  assert.equal(stale.state, "unavailable"); assert.equal(stale.problem?.code, "network"); assert.equal(stale.lastKnownIdentity?.account, "123456789012");
  assert.doesNotMatch(JSON.stringify(stale), /SENTINEL/);
});

test("credential invalidation rejects an old in-flight identity without invalidating an unrelated profile", async () => {
  const f = fixture("[profile base]\nregion=us-east-1\n[profile other]\nregion=us-east-1\ncredential_process=fixture-not-executed\n");
  const pending = new Map<string, (result: { stdout: string; stderr: string; code: number }) => void>();
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async args => new Promise(resolve => pending.set(args[args.indexOf("--profile") + 1]!, resolve)) }); disposers.push(() => service.dispose());
  const old = service.check("base"), other = service.check("other");
  const deadline = Date.now() + 5000;
  while (pending.size !== 2 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 2);
  service.invalidate(["base"]);
  const result = { stdout: '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/old"}', stderr: "", code: 0 };
  pending.get("base")!(result); pending.get("other")!(result);
  assert.equal((await old).state, "configuration-error");
  assert.equal((await other).state, "connected");
  pending.delete("base");
  const next = service.check("base");
  while (!pending.has("base") && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(pending.has("base"));
  // Failed fresh checks must not inherit the identity that completed after invalidation.
  pending.get("base")!({ stdout: "invalid", stderr: "", code: 0 });
  assert.equal((await next).lastKnownIdentity, undefined);
});

test("credential lifecycle changes expire configuration and deletion reviews even when file bytes do not change", async () => {
  const f = fixture();
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false }); disposers.push(() => service.dispose());
  const edit = await service.review({ name: "base", create: false, fields: { region: "eu-west-1" } });
  const deletion = service.deleteReview("base");
  service.invalidate(["base"]);
  await assert.rejects(service.apply(edit.id), /expired/);
  await assert.rejects(service.deleteApply(deletion.id), /expired/);
  assert.equal(readFileSync(f.configFile, "utf8"), "[profile base]\nregion=us-east-1\n");
});
test("only an explicit connection test observes native expiration without exposing exported credentials", async () => {
  const f = fixture(); const calls: string[][] = []; const future = new Date(Date.now() + 60_000).toISOString();
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async (args, options) => {
    calls.push([...args]);
    assert.equal(options?.env?.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
    if (args[0] === "configure") {
      assert.equal(options?.timeoutMs, 5_000);
      assert.equal(args[args.indexOf("--profile") + 1], "base");
      return { stdout: JSON.stringify({ Version: 1, AccessKeyId: "SENTINEL_EXPORTED_ACCESS_KEY", SecretAccessKey: "SENTINEL_EXPORTED_SECRET", SessionToken: "SENTINEL_EXPORTED_TOKEN", Expiration: future }), stderr: "", code: 0 };
    }
    return { stdout: '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/test"}', stderr: "", code: 0 };
  } }); disposers.push(() => service.dispose());
  const automatic = await service.check("base");
  assert.equal(automatic.credentialExpiration, undefined);
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [["sts", "get-caller-identity"]]);
  const explicit = await service.check("base", true);
  assert.equal(explicit.state, "connected");
  assert.deepEqual(explicit.credentialExpiration, { at: future, source: "native-export" });
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [["sts", "get-caller-identity"], ["sts", "get-caller-identity"], ["configure", "export-credentials"]]);
  assert.doesNotMatch(JSON.stringify(explicit), /SENTINEL|AccessKeyId|SecretAccessKey|SessionToken/);
});
test("unavailable, invalid or expired credential exports preserve successful identity without expiration claims", async () => {
  for (const exported of ["unsupported", "invalid-json", "expired", "wrong-version", "invalid-expiration"]) {
    const f = fixture();
    const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, run: async args => {
      if (args[0] !== "configure") return { stdout: '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/test"}', stderr: "", code: 0 };
      if (exported === "unsupported") throw new AwsConnectionError(problem("unsupported-cli"));
      return { stdout: exported === "invalid-json" ? "SENTINEL_NOT_JSON" : JSON.stringify({ Version: exported === "wrong-version" ? 2 : 1, AccessKeyId: "SENTINEL_ACCESS_KEY", SecretAccessKey: "SENTINEL_SECRET", Expiration: exported === "invalid-expiration" ? "SENTINEL_NOT_A_TIMESTAMP" : new Date(Date.now() - 60_000).toISOString() }), stderr: "", code: 0 };
    } }); disposers.push(() => service.dispose());
    const observation = await service.check("base", true);
    assert.equal(observation.state, "connected", exported); assert.equal(observation.identity?.account, "123456789012", exported);
    assert.equal(observation.credentialExpiration, undefined, exported); assert.equal(observation.problem, undefined, exported);
    assert.doesNotMatch(JSON.stringify(observation), /SENTINEL|AccessKeyId|SecretAccessKey|SessionToken/);
  }
});
test("invalid selected profiles never invoke AWS and endpoint overrides cannot validate identity", async () => {
  const f = fixture("[profile incomplete]\nregion=us-east-1\n"); let calls = 0;
  const service = new AwsConnectionsService(f.directory, { env: { ...f.env, AWS_ENDPOINT_URL: "https://malicious.invalid" }, watch: false, run: async (_args, options) => { calls++; assert.equal(options?.env?.AWS_ENDPOINT_URL, undefined); assert.equal(options?.env?.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true"); return { stdout: '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/test"}', stderr: "", code: 0 }; } }); disposers.push(() => service.dispose());
  assert.equal((await service.check("missing")).state, "configuration-error");
  assert.equal((await service.check("incomplete")).state, "configuration-error"); assert.equal(calls, 0);
  assert.equal((await service.check("base")).state, "connected"); assert.equal(calls, 1);
});
test("native Console sign-in stages its file, verifies identity, sanitizes progress and requires profile review", async () => {
  const f = fixture(); let stage = ""; let verified = 0;
  const run: AuthRunner = async command => {
    stage = command.env.AWS_CONFIG_FILE!;
    command.onOutput("https://us-east-1.signin.aws.amazon.com/v1/authorize?state=ephemeral-state\n");
    const text = readFileSync(stage, "utf8");
    writeFileSync(stage, patchIniSection(text, "profile console", { login_session: "arn:aws:iam::123456789012:user/test" }, false));
    return 0;
  };
  const coordinator = new AuthenticationCoordinator({ env: f.env, run, verify: async () => { verified++; } }); disposers.push(() => coordinator.dispose());
  const start = await coordinator.start({ method: "login", name: "console", region: "us-east-1" }, await loadAwsCatalog(f.env), capabilities);
  const complete = await terminal(coordinator, start.id);
  assert.equal(complete.state, "complete"); assert.equal(complete.reviewRequired, true); assert.equal(verified, 1);
  assert.equal(readFileSync(f.configFile, "utf8"), "[profile base]\nregion=us-east-1\n");
  assert.deepEqual(coordinator.configuration(start.id, "console")?.fields, { login_session: "arn:aws:iam::123456789012:user/test", region: "us-east-1" });
  assert.doesNotMatch(JSON.stringify(complete), /SENTINEL|ephemeral-state/);
  assert.equal(existsSync(stage), false);
  await coordinator.dispose(); assert.equal(existsSync(stage), false);
});
test("completed Identity Center setup erases sensitive snapshots and expires while idle", async t => {
  const f = fixture(); let stage = ""; let credentials = "";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const coordinator = new AuthenticationCoordinator({ env: f.env, run: async command => { stage = command.env.AWS_CONFIG_FILE!; credentials = command.env.AWS_SHARED_CREDENTIALS_FILE!; return 0; } }); disposers.push(() => coordinator.dispose());
  const start = await coordinator.start({ method: "sso", name: "team-dev", session: "team", startUrl: "https://team.awsapps.com/start", ssoRegion: "us-east-1" }, await loadAwsCatalog(f.env), capabilities);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.get(start.id).state, "complete");
  assert.equal(readFileSync(credentials, "utf8"), "");
  assert.doesNotMatch(readFileSync(stage, "utf8"), /SENTINEL|profile base/);
  assert.match(readFileSync(stage, "utf8"), /sso-session team/);
  t.mock.timers.tick(15 * 60_000 + 1);
  assert.equal(existsSync(stage), false);
  assert.throws(() => coordinator.get(start.id), /expired/);
});
test("Console identity replacement waits for explicit confirmation and reviews the changed principal", async () => {
  const previous = "arn:aws:iam::123456789012:user/previous";
  const next = "arn:aws:iam::234567890123:user/next";
  const original = `[profile console]\nregion=us-east-1\nlogin_session=${previous}\n`;
  const f = fixture(original);
  const coordinator = new AuthenticationCoordinator({ env: f.env, verify: async () => {}, run: async command => new Promise(resolve => {
    command.onInput(value => {
      assert.equal(value, "y\n");
      const staged = command.env.AWS_CONFIG_FILE!;
      writeFileSync(staged, patchIniSection(readFileSync(staged, "utf8"), "profile console", { login_session: next }, false));
      resolve(0);
    });
    command.onOutput(`Profile console is already configured to use session ${previous}. Do you want to overwrite it to use ${next} instead? (y/n): `);
  }) }); disposers.push(() => coordinator.dispose());
  const start = await coordinator.start({ profile: "console" }, await loadAwsCatalog(f.env), capabilities);
  const waiting = await terminal(coordinator, start.id);
  assert.equal(waiting.state, "confirmation-required");
  assert.equal(waiting.confirmation?.previousArn, previous); assert.equal(waiting.confirmation?.nextArn, next);
  assert.equal(readFileSync(f.configFile, "utf8"), original);
  coordinator.confirm(start.id, true);
  const complete = await terminal(coordinator, start.id);
  assert.equal(complete.state, "complete"); assert.equal(complete.reviewRequired, true);
  assert.equal(coordinator.configuration(start.id, "console")?.fields.login_session, next);
  assert.equal(readFileSync(f.configFile, "utf8"), original);
});
test("native auth ignores endpoint overrides and uses the same region precedence as identity checks", async () => {
  const f = fixture("[profile console]\nregion=us-east-1\nlogin_session=arn:aws-us-gov:iam::123456789012:user/test\n");
  const coordinator = new AuthenticationCoordinator({ env: { ...f.env, AWS_REGION: "us-gov-west-1", AWS_PROFILE: "missing-inherited-profile", AWS_DEFAULT_PROFILE: "missing-inherited-default", AWS_ENDPOINT_URL: "https://untrusted.invalid", AWS_ENDPOINT_URL_SIGNIN: "https://untrusted.invalid" }, verify: async () => {}, run: async command => {
    assert.equal(command.env.AWS_ENDPOINT_URL, undefined); assert.equal(command.env.AWS_ENDPOINT_URL_SIGNIN, undefined); assert.equal(command.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
    assert.equal(command.env.AWS_PROFILE, "console"); assert.equal(command.env.AWS_DEFAULT_PROFILE, undefined);
    assert.equal(command.args[command.args.indexOf("--region") + 1], "us-gov-west-1"); return 0;
  } }); disposers.push(() => coordinator.dispose());
  const start = await coordinator.start({ profile: "console" }, await loadAwsCatalog(f.env), capabilities);
  assert.equal((await terminal(coordinator, start.id)).state, "complete");
});
test("shared Identity Center profiles coalesce one native authentication and cancel safely", async () => {
  const f = fixture("[sso-session team]\nsso_start_url=https://team.awsapps.com/start\nsso_region=us-east-1\n[profile one]\nsso_session=team\nsso_account_id=123456789012\nsso_role_name=Developer\nregion=us-east-1\n[profile two]\nsso_session=team\nsso_account_id=123456789012\nsso_role_name=Admin\nregion=us-east-1\n");
  let calls = 0;
  const coordinator = new AuthenticationCoordinator({ env: f.env, run: async command => { calls++; return new Promise(resolve => { command.signal.addEventListener("abort", () => resolve(1), { once: true }); }); } }); disposers.push(() => coordinator.dispose());
  const catalog = await loadAwsCatalog(f.env);
  const one = await coordinator.start({ profile: "one" }, catalog, capabilities);
  const two = await coordinator.start({ profile: "two" }, catalog, capabilities);
  assert.equal(one.id, two.id); assert.deepEqual(one.affectedProfiles, ["one", "two"]);
  assert.equal(calls, 1); assert.equal(coordinator.cancel(one.id).state, "canceled");
});

test("Windows native-session leases use USERPROFILE even when HOME differs", { skip: process.platform !== "win32" }, async () => {
  const f = fixture("[sso-session team]\nsso_start_url=https://team.awsapps.com/start\nsso_region=us-east-1\n[profile one]\nsso_session=team\nsso_account_id=123456789012\nsso_role_name=Developer\n");
  const run: AuthRunner = async command => new Promise(resolve => command.signal.addEventListener("abort", () => resolve(1), { once: true }));
  const first = new AuthenticationCoordinator({ env: f.env, run }); disposers.push(() => first.dispose());
  const second = new AuthenticationCoordinator({ env: { ...f.env, HOME: path.join(f.directory, "different-sdk-home") }, run }); disposers.push(() => second.dispose());
  const catalog = await loadAwsCatalog(f.env);
  await first.start({ profile: "one" }, catalog, capabilities);
  await assert.rejects(second.start({ profile: "one" }, catalog, capabilities), /Another Studio process is authenticating/);
});

test("Windows native authentication forwards confirmation input and stops descendants at command completion", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(), fake = path.join(f.directory, "synthetic-login.mjs"), heartbeat = path.join(f.directory, "heartbeat");
  writeFileSync(fake, `import fs from "node:fs"; import {spawn} from "node:child_process";
process.stdin.once("data",data=>{if(String(data)!=="confirm\\n")process.exit(2);const child=spawn(process.execPath,["-e",'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,"x"),10);'],{stdio:["ignore","inherit","inherit"]});child.unref();setInterval(()=>{if(fs.existsSync(process.env.HEARTBEAT)){process.stdout.write("confirmed");process.exit(0);}},10);});`);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  let output = "";
  try {
    const code = await runAuthenticationCommand({ args: [], env: { ...f.env, FRAMEWORK_AWS_CLI: fake, HEARTBEAT: heartbeat }, signal: controller.signal, onOutput: chunk => { output += chunk; }, onInput: write => write("confirm\n") });
    assert.equal(code, 0); assert.equal(output, "confirmed");
    const stopped = readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readFileSync(heartbeat, "utf8"), stopped);
  } finally { clearTimeout(timer); controller.abort(); }
});
test("authentication failures and unknown interaction never expose raw stderr", async () => {
  const f = fixture();
  const coordinator = new AuthenticationCoordinator({ env: f.env, run: async command => { command.onOutput("SENTINEL_SECRET\nEnter access key: "); return 1; } }); disposers.push(() => coordinator.dispose());
  const start = await coordinator.start({ method: "login", name: "console", region: "us-east-1" }, await loadAwsCatalog(f.env), capabilities);
  const end = await terminal(coordinator, start.id);
  assert.equal(end.state, "failed"); assert.doesNotMatch(JSON.stringify(end), /SENTINEL_SECRET/); assert.match(end.message, /terminal/);
});

test("failed and canceled native sign-in invalidate possibly changed shared caches", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); const changed: string[][] = [];
    const coordinator = new AuthenticationCoordinator({ env: f.env, changed: profiles => changed.push([...profiles]), run: async command => {
      assert.equal(command.env.HOME, f.directory);
      assert.equal(command.env.USERPROFILE, f.directory);
      assert.equal(command.env.AWS_LOGIN_CACHE_DIRECTORY, path.join(f.directory, "login-cache"));
      if (cancel) await new Promise(resolve => command.signal.addEventListener("abort", resolve, { once: true }));
      return 1;
    } }); disposers.push(() => coordinator.dispose());
    const start = await coordinator.start({ method: "login", name: "console", region: "us-east-1" }, await loadAwsCatalog(f.env), capabilities);
    if (cancel) coordinator.cancel(start.id);
    await terminal(coordinator, start.id);
    await coordinator.dispose();
    assert.deepEqual(changed, [["console"]]);
  }
});

test("failed native sign-out invalidates observations and reviews because cache effects are uncertain", async () => {
  const f = fixture("[profile console]\nregion=us-east-1\nlogin_session=arn:aws:iam::123456789012:user/test\n");
  const changed: string[][] = [];
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, changed: profiles => changed.push([...profiles]), run: async () => { throw new Error("fixture partial logout"); } }); disposers.push(() => service.dispose());
  const review = await service.logoutReview("console");
  await assert.rejects(service.logoutApply(review.id), /could not be confirmed/);
  assert.deepEqual(changed, [["console"]]);
  await assert.rejects(service.logoutApply(review.id), /expired or configuration changed/);
});
test("authentication links allow only native HTTPS AWS destinations", () => {
  assert.equal(safeAuthorizationUrl("javascript:alert(1)"), undefined);
  assert.equal(safeAuthorizationUrl("https://awsapps.com.evil.invalid/login"), undefined);
  assert.equal(safeAuthorizationUrl("https://username:password@team.awsapps.com/start"), undefined);
  assert.equal(safeAuthorizationUrl("https://team.awsapps.com/start"), "https://team.awsapps.com/start");
  assert.equal(safeAuthorizationUrl("https://us-east-1.signin.aws.amazon.com/v1/authorize?state=fixture"), "https://us-east-1.signin.aws.amazon.com/v1/authorize?state=fixture");
});
test("SSO logout describes all profiles and refuses while affected operations run", async () => {
  const f = fixture("[sso-session team]\nsso_start_url=https://team.awsapps.com/start\nsso_region=us-east-1\n[profile one]\nsso_session=team\nsso_account_id=123456789012\nsso_role_name=Developer\n[profile two]\nsso_session=team\nsso_account_id=123456789012\nsso_role_name=Admin\n"); let busy = false; const calls: string[][] = [];
  const service = new AwsConnectionsService(f.directory, { env: f.env, watch: false, busy: () => busy, run: async args => { calls.push([...args]); return { stdout: "", stderr: "", code: 0 }; } }); disposers.push(() => service.dispose());
  const review = await service.logoutReview("one"); assert.deepEqual(review.affectedProfiles, ["one", "two"]); assert.match(review.message, /all Identity Center sessions/);
  busy = true; await assert.rejects(service.logoutApply(review.id), /in use/); assert.equal(calls.length, 0);
  busy = false; await service.logoutApply(review.id); assert.deepEqual(calls[0]?.slice(0, 4), ["sso", "logout", "--profile", "one"]);
});
