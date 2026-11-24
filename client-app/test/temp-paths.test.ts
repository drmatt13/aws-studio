import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAwsExecutionSnapshot, inspectAwsProfiles } from "aws-studio/cli/aws-connections";
import { createPrivateDirectorySync, ensurePrivateDirectory, writePrivateFileSync } from "aws-studio/cli/private-files";
import { AuthenticationCoordinator } from "../server/aws-connections/authentication";

test("POSIX OS-temp aliases support private snapshots and authentication leases without allowing explicit linked paths", { skip: process.platform === "win32" }, async () => {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio temp alias \u00e9 ")));
  const temporary = path.join(root, "physical-temp"), alias = path.join(root, "temp-alias");
  mkdirSync(temporary); symlinkSync(temporary, alias, "dir");
  const config = path.join(root, "config"), credentials = path.join(root, "credentials");
  writeFileSync(config, "[profile fixture]\nsso_session=fixture\nregion=us-east-1\n[sso-session fixture]\nsso_start_url=https://fixture.awsapps.com/start\nsso_region=us-east-1\n");
  writeFileSync(credentials, "");
  const env = { HOME: root, USERPROFILE: root, AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials };
  const before = readFileSync(config, "utf8");
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = alias; process.env.TMP = alias; process.env.TMPDIR = alias;
  const coordinator = new AuthenticationCoordinator({ env });
  let snapshot: ReturnType<typeof createAwsExecutionSnapshot> | undefined, release: (() => void) | undefined;
  try {
    assert.equal(os.tmpdir(), alias, "the fixture uses an actual OS-temp symlink without a platform mock");
    snapshot = createAwsExecutionSnapshot(env);
    assert.equal(path.dirname(snapshot.directory), temporary);
    const catalog = inspectAwsProfiles(env);
    release = coordinator.lockProfiles(catalog, ["fixture"]);
    assert.equal(existsSync(path.join(temporary, `aws-studio-auth-${process.getuid!()}`)), true);
    assert.throws(() => coordinator.lockProfiles(catalog, ["fixture"]), /Another Studio process is authenticating/);
    assert.throws(() => ensurePrivateDirectory(path.join(alias, "explicit-directory")), /linked/);
    assert.throws(() => writePrivateFileSync(path.join(alias, "explicit-file"), "must not appear"), /linked/);
    assert.throws(() => createPrivateDirectorySync(path.join(alias, "explicit-group-"), { config: "must not appear" }), /linked/);
    assert.equal(readFileSync(config, "utf8"), before);
    assert.equal(readFileSync(credentials, "utf8"), "");
  } finally {
    release?.(); snapshot?.dispose(); await coordinator.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (path.dirname(root) !== realpathSync(os.tmpdir()) || !path.basename(root).startsWith("studio temp alias \u00e9 ")) throw new Error("Temp-alias fixture escaped its task root.");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
