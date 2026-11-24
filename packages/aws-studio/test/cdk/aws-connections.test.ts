import { testProjectRoot } from "./support/test-project";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AwsConnectionError, awsIdentity, classifyAwsConnectionError, cliCredentialProvider, connectionEnvironment, createAwsExecutionSnapshot, inspectAwsProfiles, loadAwsCatalog, readAwsFiles, resolveAwsRegion, runPrivateAws, withoutAwsCliHistory } from "../../cli/aws-connections";
import { listAwsProfiles } from "../../cli/aws-profiles";
import { isAwsProfileName } from "../../cli/aws-connection-contract";

function fixture(config = "", credentials = "") {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-connection-test-"));
  const configFile = path.join(directory, "config"), credentialsFile = path.join(directory, "credentials");
  writeFileSync(configFile, config, { mode: 0o600 }); writeFileSync(credentialsFile, credentials, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, AWS_LOGIN_CACHE_DIRECTORY: path.join(directory, "login-cache"), AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile };
  return { directory, configFile, credentialsFile, env, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
const staticCredentials = "[base]\naws_access_key_id = SYNTHETIC_ACCESS_KEY\naws_secret_access_key = SYNTHETIC_SECRET_SENTINEL\n";

test("existing profile identifiers accept spaces without accepting section or control characters", () => {
  for (const name of ["team developer", "team @ administrator", "x".repeat(512)]) assert.equal(isAwsProfileName(name), true);
  for (const name of [undefined, 7, "", "   ", "x".repeat(513), "name\nnext", "name\x7f", "name\x85", "[profile injected]"]) assert.equal(isAwsProfileName(name), false);
});

test("catalog uses effective files, retains role relationships, and never executes providers or exposes secret directives", async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\ncredential_process = never-run --secret PROCESS_SECRET_SENTINEL\n[profile admin]\nrole_arn = arn:aws:iam::123456789012:role/Admin\nsource_profile = base\n[sso-session team]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\n[profile sso]\nsso_session = team\nsso_account_id = 123456789012\nsso_role_name = Developer\n', staticCredentials);
  try {
    const catalog = await loadAwsCatalog(f.env);
    assert.deepEqual(catalog.profiles.map(item => item.name), ["admin", "base", "sso"]);
    const role = catalog.profiles.find(item => item.name === "admin")!;
    assert.equal(role.kind, "assume-role"); assert.equal(role.sourceProfile, "base");
    assert.deepEqual(catalog.sessions[0]?.profiles, ["sso"]);
    assert.equal(role.diagnostics.length, 0);
    assert.ok(!JSON.stringify(catalog).includes("SECRET_SENTINEL"));
    assert.ok(!JSON.stringify(catalog).includes(f.directory), "public metadata contains no machine paths");
    assert.deepEqual(listAwsProfiles(f.env).find(item => item.name === "base"), { name: "base", kind: "process", region: "eu-west-1" });
  } finally { f.dispose(); }
});

test("catalog reports missing sources, cycles, incomplete keys, malformed and duplicate definitions", async () => {
  const f = fixture('[profile first]\nrole_arn = arn:aws:iam::123456789012:role/Admin\nsource_profile = second\n[profile second]\nrole_arn = arn:aws:iam::123456789012:role/Admin\nsource_profile = first\n[profile missing]\nrole_arn = arn:aws:iam::123456789012:role/Admin\nsource_profile = absent\n[profile empty]\nregion = eu-west-1\n[profile duplicate]\nregion = eu-west-1\nregion = us-east-1\n[broken\n', '[partial]\naws_access_key_id = SYNTHETIC_KEY\n');
  try {
    const catalog = await loadAwsCatalog(f.env);
    assert.ok(catalog.diagnostics.some(item => item.code === "invalid-section"));
    assert.ok(catalog.profiles.find(item => item.name === "first")?.diagnostics.some(item => item.code === "role-cycle"));
    assert.ok(catalog.profiles.find(item => item.name === "missing")?.diagnostics.some(item => item.code === "missing-source-profile"));
    assert.ok(catalog.profiles.find(item => item.name === "empty")?.diagnostics.some(item => item.code === "no-credential-route"));
    assert.equal(catalog.profiles.find(item => item.name === "duplicate")?.editable, false);
    assert.throws(() => connectionEnvironment(f.env, "empty"), AwsConnectionError);
  } finally { f.dispose(); }
});

test("malformed public settings and token-bearing URLs are diagnostic-only metadata", async () => {
  const f = fixture('[profile base]\nregion = SYNTHETIC_SECRET_SENTINEL\nlogin_session = SYNTHETIC_SECRET_SENTINEL\nsso_start_url = https://example.awsapps.com/start?token=SYNTHETIC_SECRET_SENTINEL\n[sso-session unsafe]\nsso_start_url = https://user:SYNTHETIC_SECRET_SENTINEL@example.awsapps.com/start\nsso_region = SYNTHETIC_SECRET_SENTINEL\n');
  try {
    const catalog = await loadAwsCatalog(f.env);
    assert.ok(!JSON.stringify(catalog).includes("SYNTHETIC_SECRET_SENTINEL"));
    assert.ok(catalog.profiles[0]?.diagnostics.some(item => item.code === "invalid-public-setting"));
    assert.deepEqual(resolveAwsRegion("base", undefined, { ...f.env, AWS_REGION: "SYNTHETIC_SECRET_SENTINEL" }), { source: "missing" });
  } finally { f.dispose(); }
});

test("CLI profile names with spaces and static self-source roles keep their configured metadata", async () => {
  const f = fixture('[profile "team developer"]\nrole_arn = arn:aws-us-gov:iam::123456789012:role/Admin\nsource_profile = base\n[profile self]\nrole_arn = arn:aws-cn:iam::123456789012:role/Admin\nsource_profile = self\n', `${staticCredentials}[self]\naws_access_key_id = SYNTHETIC\naws_secret_access_key = SYNTHETIC\n`);
  try {
    const catalog = await loadAwsCatalog(f.env);
    assert.equal(catalog.profiles.find(item => item.name === "team developer")?.sourceProfile, "base");
    assert.equal(catalog.profiles.find(item => item.name === "team developer")?.roleArn, "arn:aws-us-gov:iam::123456789012:role/Admin");
    assert.deepEqual(catalog.profiles.find(item => item.name === "self")?.diagnostics, []);
    assert.equal(connectionEnvironment(f.env, "self").AWS_PROFILE, "self");
  } finally { f.dispose(); }
});

test("explicit named profile drops ambient credentials and endpoint overrides without a metadata fallback", () => {
  const f = fixture("[profile base]\nregion = eu-west-1\n", staticCredentials);
  try {
    const env = connectionEnvironment({ ...f.env, AWS_ACCESS_KEY_ID: "ambient", AWS_SECRET_ACCESS_KEY: "ambient", AWS_WEB_IDENTITY_TOKEN_FILE: "/private/token", AWS_ROLE_ARN: "other-role", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://untrusted", AWS_ENDPOINT_URL: "http://untrusted", AWS_ENDPOINT_URL_STS: "http://untrusted", AWS_REGION: "us-west-2", AWS_DEFAULT_PROFILE: "other" }, "base");
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined); assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.AWS_ROLE_ARN, undefined); assert.equal(env.AWS_WEB_IDENTITY_TOKEN_FILE, undefined);
    assert.equal(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined); assert.equal(env.AWS_EC2_METADATA_DISABLED, "true");
    assert.equal(env.AWS_PROFILE, "base"); assert.equal(env.AWS_REGION, "us-west-2");
    assert.equal(env.AWS_ENDPOINT_URL, undefined); assert.equal(env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
    assert.throws(() => connectionEnvironment(f.env, "missing"), (error: unknown) => error instanceof AwsConnectionError && error.problem.code === "profile");
  } finally { f.dispose(); }
});

test("intentional Environment and metadata role sources retain only their declared inputs", () => {
  const f = fixture('[profile environment]\nrole_arn = arn:aws:iam::123456789012:role/Admin\ncredential_source = Environment\n[profile derived]\nrole_arn = arn:aws:iam::123456789012:role/Next\nsource_profile = environment\n[profile instance]\nrole_arn = arn:aws:iam::123456789012:role/Admin\ncredential_source = Ec2InstanceMetadata\n[profile container]\nrole_arn = arn:aws:iam::123456789012:role/Admin\ncredential_source = EcsContainer\n');
  try {
    const base = { ...f.env, AWS_ACCESS_KEY_ID: "synthetic", AWS_SECRET_ACCESS_KEY: "synthetic", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://container" };
    assert.equal(connectionEnvironment(base, "derived").AWS_ACCESS_KEY_ID, "synthetic");
    assert.equal(connectionEnvironment(base, "instance").AWS_ACCESS_KEY_ID, undefined);
    assert.equal(connectionEnvironment(base, "instance").AWS_EC2_METADATA_DISABLED, "false");
    assert.equal(connectionEnvironment(base, "container").AWS_CONTAINER_CREDENTIALS_FULL_URI, "http://container");
  } finally { f.dispose(); }
});

test("region resolution is explicit, AWS_REGION, AWS_DEFAULT_REGION, profile, then missing", () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  try {
    assert.deepEqual(resolveAwsRegion("base", "ap-south-1", { ...f.env, AWS_REGION: "us-west-2" }), { value: "ap-south-1", source: "explicit" });
    assert.deepEqual(resolveAwsRegion("base", undefined, { ...f.env, AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-east-1" }), { value: "us-west-2", source: "environment" });
    assert.deepEqual(resolveAwsRegion("base", undefined, { ...f.env, AWS_DEFAULT_REGION: "us-east-1" }), { value: "us-east-1", source: "environment" });
    assert.deepEqual(resolveAwsRegion("base", undefined, f.env), { value: "eu-west-1", source: "profile" });
    assert.deepEqual(resolveAwsRegion("missing", undefined, f.env), { source: "missing" });
  } finally { f.dispose(); }
});

test("private snapshots disable history in both files without changing original bytes", () => {
  const config = '# keep\r\n[profile base]\r\ncli_history = enabled\r\nCLI_HISTORY = enabled\r\nCli_History = enabled\r\nregion = eu-west-1\r\n[services local]\r\ncustom =\r\n  endpoint_url = http://example\r\n';
  const credentials = `${staticCredentials}cli_history = enabled\nCLI_HISTORY = enabled\nCli_History = enabled\n[only-credentials]\naws_access_key_id = SYNTHETIC\naws_secret_access_key = SYNTHETIC\n`;
  const f = fixture(config, credentials);
  try {
    const before = readAwsFiles(f.env).revision;
    const snapshot = createAwsExecutionSnapshot(f.env);
    assert.equal(readFileSync(f.configFile, "utf8"), config); assert.equal(readFileSync(f.credentialsFile, "utf8"), credentials);
    assert.doesNotMatch(readFileSync(snapshot.configFile, "utf8"), /cli_history\s*=\s*enabled/i);
    assert.doesNotMatch(readFileSync(snapshot.credentialsFile, "utf8"), /cli_history\s*=\s*enabled/i);
    assert.ok(readFileSync(snapshot.configFile, "utf8").includes("[profile only-credentials]"));
    if (process.platform !== "win32") { assert.equal(lstatSync(snapshot.directory).mode & 0o777, 0o700); assert.equal(lstatSync(snapshot.configFile).mode & 0o777, 0o600); }
    snapshot.dispose(); snapshot.dispose();
    assert.equal(existsSync(snapshot.directory), false); assert.equal(readAwsFiles(f.env).revision, before);
    assert.ok(withoutAwsCliHistory(config, "config").includes("# keep\r\n"));
  } finally { f.dispose(); }
});

test("symlinked files are readable discovery sources but are not editable", { skip: process.platform === "win32" }, async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  try {
    const link = path.join(f.directory, "linked-config"); symlinkSync(f.configFile, link);
    const catalog = await loadAwsCatalog({ ...f.env, AWS_CONFIG_FILE: link });
    assert.equal(catalog.profiles[0]?.editable, false);
    assert.match(catalog.profiles[0]?.provenance.readOnlyReason ?? "", /symbolic link/);
  } finally { f.dispose(); }
});

test("CLI credential provider coalesces refresh and does not expose secret failure output", async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  try {
    const fake = path.join(f.directory, "fake.mjs"), receipt = path.join(f.directory, "count");
    writeFileSync(fake, 'import fs from "node:fs"; fs.appendFileSync(process.env.RECEIPT, "x"); process.stdout.write(JSON.stringify({Version:1,AccessKeyId:"SYNTHETIC",SecretAccessKey:"SYNTHETIC_SECRET_SENTINEL",SessionToken:"SYNTHETIC_TOKEN",Expiration:new Date(Date.now()+3600000).toISOString()}));');
    const provider = cliCredentialProvider("base", { env: { ...f.env, FRAMEWORK_AWS_CLI: fake, RECEIPT: receipt } });
    const identities = await Promise.all([provider(), provider(), provider()]);
    assert.equal(readFileSync(receipt, "utf8"), "x"); assert.equal(identities[0]?.accessKeyId, "SYNTHETIC");
    await provider(); assert.equal(readFileSync(receipt, "utf8"), "x");
    writeFileSync(fake, 'process.stderr.write("credential_process failed: SYNTHETIC_SECRET_SENTINEL"); process.exitCode=1;');
    await assert.rejects(runPrivateAws(["configure", "export-credentials"], { env: { ...f.env, FRAMEWORK_AWS_CLI: fake } }), (error: unknown) => {
      assert.ok(error instanceof AwsConnectionError); assert.equal(error.problem.code, "external-provider"); assert.ok(!JSON.stringify(error).includes("SECRET_SENTINEL")); return true;
    });
  } finally { f.dispose(); }
});

test("private CLI timeout and cancellation clean their snapshots", async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  try {
    const fake = path.join(f.directory, "hang.mjs"), receipt = path.join(f.directory, "snapshot-receipt");
    writeFileSync(fake, 'import fs from "node:fs"; fs.writeFileSync(process.env.RECEIPT, process.env.AWS_CONFIG_FILE); setInterval(()=>{}, 1000);');
    const env = { ...f.env, FRAMEWORK_AWS_CLI: fake, RECEIPT: receipt };
    await assert.rejects(runPrivateAws(["unused"], { env, timeoutMs: 5000 }), (error: unknown) => error instanceof AwsConnectionError && error.problem.code === "timeout");
    assert.equal(existsSync(path.dirname(readFileSync(receipt, "utf8"))), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runPrivateAws(["unused"], { env, signal: controller.signal }), (error: unknown) => error instanceof AwsConnectionError && error.problem.code === "canceled");
  } finally { f.dispose(); }
});

test("private CLI cancellation waits for child closure and stops its descendants before releasing snapshots", async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  try {
    const fake = path.join(f.directory, "parent.mjs"), receipt = path.join(f.directory, "receipt.json"), heartbeat = path.join(f.directory, "heartbeat");
    writeFileSync(fake, `import fs from "node:fs"; import {spawn} from "node:child_process";
const child=spawn(process.execPath,["-e",'const fs=require("node:fs"); setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,"x"),10);'],{stdio:["ignore","inherit","inherit"]});
fs.writeFileSync(process.env.RECEIPT,JSON.stringify({pid:process.pid,config:process.env.AWS_CONFIG_FILE})); setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const command = runPrivateAws(["unused"], { env: { ...f.env, FRAMEWORK_AWS_CLI: fake, RECEIPT: receipt, HEARTBEAT: heartbeat }, signal: controller.signal });
    void command.catch(() => {});
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(heartbeat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(heartbeat), "the fixture descendant started before cancellation");
      const observed = JSON.parse(readFileSync(receipt, "utf8"));
      assert.equal(existsSync(observed.config), true);
      controller.abort();
      await assert.rejects(command, (error: unknown) => error instanceof AwsConnectionError && error.problem.code === "canceled");
      assert.throws(() => process.kill(observed.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
      assert.equal(existsSync(path.dirname(observed.config)), false);
      const stopped = readFileSync(heartbeat, "utf8");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(readFileSync(heartbeat, "utf8"), stopped, "no descendant keeps running after cancellation completes");
    } finally { controller.abort(); await command.catch(() => {}); }
  } finally { f.dispose(); }
});

test("private CLI completion stops a descendant retaining output after the direct command exits", async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  try {
    const fake = path.join(f.directory, "exiting-parent.mjs"), heartbeat = path.join(f.directory, "heartbeat");
    writeFileSync(fake, `import fs from "node:fs"; import {spawn} from "node:child_process";
const child=spawn(process.execPath,["-e",'const fs=require("node:fs"); setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,"x"),10);'],{stdio:["ignore","inherit","inherit"]}); child.unref();
setInterval(()=>{if(fs.existsSync(process.env.HEARTBEAT)){process.stdout.write("complete"); process.exit(0);}},10);`);
    const result = await runPrivateAws(["unused"], { env: { ...f.env, FRAMEWORK_AWS_CLI: fake, HEARTBEAT: heartbeat }, timeoutMs: 10_000 });
    assert.equal(result.stdout, "complete");
    const stopped = readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readFileSync(heartbeat, "utf8"), stopped);
  } finally { f.dispose(); }
});

test("POSIX private CLI supervision stops descendants when its calling process is killed", { skip: process.platform === "win32" }, async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\n', staticCredentials);
  const fake = path.join(f.directory, "hanging-cli.mjs"), ownerFile = path.join(f.directory, "owner.mjs"), receiptFile = path.join(f.directory, "receipt.json"), heartbeat = path.join(f.directory, "heartbeat");
  writeFileSync(fake, `import fs from "node:fs"; import {spawn} from "node:child_process";
const child=spawn(process.execPath,["-e",'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,"x"),10);'],{stdio:["ignore","inherit","inherit"]});
fs.writeFileSync(process.env.RECEIPT,JSON.stringify({pid:process.pid,child:child.pid,config:process.env.AWS_CONFIG_FILE}));setInterval(()=>{},1000);`);
  const entry = pathToFileURL(require.resolve("aws-studio/cli/aws-connections")).href;
  writeFileSync(ownerFile, `import {runPrivateAws} from ${JSON.stringify(entry)};await runPrivateAws(["unused"],{timeoutMs:60000});`);
  const loader = pathToFileURL(createRequire(path.join(testProjectRoot, "cdk-app/package.json")).resolve("tsx")).href;
  const owner = spawn(process.execPath, ["--import", loader, ownerFile], { env: { ...process.env, ...f.env, FRAMEWORK_AWS_CLI: fake, RECEIPT: receiptFile, HEARTBEAT: heartbeat }, stdio: "ignore" });
  const closed = new Promise<void>((resolve, reject) => { owner.once("close", () => resolve()); owner.once("error", reject); });
  void closed.catch(() => {});
  let receipt: { pid: number; child: number; config: string } | undefined;
  const running = (pid: number) => {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1000 });
    assert.ifError(result.error);
    const state = result.stdout.trim();
    return result.status === 0 && state.length > 0 && !state.startsWith("Z");
  };
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(heartbeat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(heartbeat), "the private CLI and its descendant started");
    receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.ok(running(receipt!.pid) && running(receipt!.child));
    owner.kill("SIGKILL"); await closed;
    const shutdownDeadline = Date.now() + 7000;
    while ((running(receipt!.pid) || running(receipt!.child)) && Date.now() < shutdownDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(running(receipt!.pid) || running(receipt!.child), false, "the stdin lifeline releases the owned command group after abrupt parent death");
  } finally {
    owner.kill("SIGKILL"); await closed;
    if (receipt) {
      try { process.kill(-receipt.pid, "SIGKILL"); } catch { /* Owned group already stopped. */ }
      const snapshot = path.dirname(receipt.config);
      assert.match(path.basename(snapshot), /^aws-studio-connection-[A-Za-z0-9]+$/);
      assert.equal(path.dirname(snapshot), realpathSync(os.tmpdir()));
      rmSync(snapshot, { recursive: true, force: true });
    }
    f.dispose();
  }
});

test("diagnostics distinguish network, expired, role permissions, and missing region without raw errors", () => {
  assert.equal(classifyAwsConnectionError("Could not connect to the endpoint URL").code, "network");
  assert.equal(classifyAwsConnectionError("ExpiredToken: token expired").code, "expired");
  assert.equal(classifyAwsConnectionError("AccessDenied when calling AssumeRole").code, "assume-role");
  assert.equal(classifyAwsConnectionError("You must specify a region").code, "missing-region");
  assert.equal(awsIdentity("123456789012", "arn:aws:sts::123456789012:assumed-role/Admin/session").summary, "Admin / session");
  assert.equal(awsIdentity("123456789012", "arn:aws:iam::123456789012:root").principalKind, "root");
});

test("native CLI private export uses synthetic credentials without history or AWS requests", { skip: spawnSync("aws", ["--version"], { encoding: "utf8" }).status !== 0 }, async () => {
  const f = fixture('[profile base]\nregion = eu-west-1\nCLI_HISTORY = enabled\n', `${staticCredentials}Cli_History = enabled\n`);
  try {
    const history = path.join(f.directory, "history", "history.db");
    const provider = cliCredentialProvider("base", { env: { ...f.env, AWS_CLI_HISTORY_FILE: history } });
    assert.equal((await provider()).accessKeyId, "SYNTHETIC_ACCESS_KEY");
    assert.equal(existsSync(history), false);
    assert.ok(readFileSync(f.configFile, "utf8").includes("CLI_HISTORY = enabled"));
    assert.ok(readFileSync(f.credentialsFile, "utf8").includes("SYNTHETIC_SECRET_SENTINEL"));
  } finally { f.dispose(); }
  const spaced = fixture("", staticCredentials.replace("[base]", "[team developer]"));
  try {
    const provider = cliCredentialProvider("team developer", { env: spaced.env });
    assert.equal((await provider()).accessKeyId, "SYNTHETIC_ACCESS_KEY", "credential-only spaced names use a native-compatible quoted snapshot section");
    assert.equal(readFileSync(spaced.configFile, "utf8"), "");
  } finally { spaced.dispose(); }
});
