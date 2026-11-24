import { testProjectRoot } from "../../../scripts/test-project";
import { installGenerationFixture } from "../support/project-cli";
import { studioProjectScratch } from "../support/source-fixture";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import type { Snapshot } from "../../shared/model";
import type { BatchPlanResponse, ApplyResponse } from "../../shared/api";
import { test, expect, assertAccessible } from "./support/test";

/** Browser controls exercise the actual guarded source transaction in a disposable checkout. */
test("Cognito IAM and disconnected stack access edit through real source review and apply", async ({ page, studio }, info) => {
  test.skip(info.project.name !== "chromium-dark", "The real source transaction is theme independent; control coverage runs in both themes.");
  test.setTimeout(900_000);
  const repository = path.resolve(__dirname, "../../..");
  const root = studioProjectScratch("permissions-browser-");
  let worker: ChildProcess | undefined, current: Snapshot;
  let serial = 0, diagnostics = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const request = <T,>(method: string, args: unknown): Promise<T> => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); worker!.send({ id, method, args }); });
  try {
    for (const relative of ["framework-config", "cdk-app/lib", "cdk-app/bin", "compute/events/cognito-pre-signup-trigger"]) mkdirSync(path.join(root, relative), { recursive: true });
    installGenerationFixture(root);
    for (const relative of ["framework-config/defaults.ts", "framework-config/workload-types.ts", "framework-config/templates", "framework-config/networks/application.ts"]) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      cpSync(path.join(testProjectRoot, relative), path.join(root, relative), { recursive: true });
    }
    writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
    writeFileSync(path.join(root, "cdk-app/cdk.json"), '{"app":"tsx bin/app.ts"}');
    writeFileSync(path.join(root, "compute/events/cognito-pre-signup-trigger/index.ts"), "export const lambdaHandler = async (event: unknown) => event;\n");
    writeFileSync(path.join(root, "framework-config/stacks.ts"), 'import { defineStacks, stack } from "aws-studio/config"; import type { ReferenceExamples } from "../cdk-app/lib/examples"; export const stacks = defineStacks({ referenceExamples: stack<ReferenceExamples>() });');
    writeFileSync(path.join(root, "framework-config/inputs.ts"), 'import { defineInputs } from "aws-studio/config"; export const inputs = defineInputs({});');
    writeFileSync(path.join(root, "cdk-app/lib/examples.ts"), 'import { Stack } from "aws-cdk-lib"; import * as s3 from "aws-cdk-lib/aws-s3"; import * as dynamodb from "aws-cdk-lib/aws-dynamodb"; import * as sqs from "aws-cdk-lib/aws-sqs"; export class ReferenceExamples extends Stack { public readonly files: s3.IBucket = new s3.Bucket(this, "Files"); public readonly records: dynamodb.ITable = new dynamodb.Table(this, "Records", {partitionKey:{name:"pk",type:dynamodb.AttributeType.STRING}}); public readonly queue: sqs.IQueue = new sqs.Queue(this,"Queue"); }');
    writeFileSync(path.join(root, "cdk-app/bin/app.ts"), 'import { App } from "aws-cdk-lib"; new App();');
    const configFile = path.join(root, "framework.config.ts");
    writeFileSync(configFile, 'import { defineFrameworkConfig } from "aws-studio/config"; import { defaults } from "./framework-config/defaults"; import { stacks } from "./framework-config/stacks"; import { applicationVpc } from "./framework-config/networks/application"; export default defineFrameworkConfig({ defaults, stacks, networks:[applicationVpc], http: [], webSocket: [], services: [], tasks: [], events: [{"cognito-pre-signup-trigger": { directory:"compute/events/cognito-pre-signup-trigger",cloud:{access:[{actions:["cognito-idp:AdminLinkProviderForUser","cognito-idp:ListUsers"],resources:["arn:{partition}:cognito-idp:{region}:{account}:userpool/*"]}]}}}] });');
    const ready = new Promise<Snapshot>((resolve, reject) => pending.set(0, { resolve, reject }));
    worker = fork(path.join(__dirname, "support/permission-source-worker.ts"), [root], { cwd: repository, execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    worker.stdout?.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-20_000); });
    worker.stderr?.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-20_000); });
    worker.on("message", (message: { id: number; value?: unknown; error?: string }) => { const waiting = pending.get(message.id); if (waiting) { pending.delete(message.id); if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.value); } });
    worker.on("exit", code => { for (const value of pending.values()) value.reject(new Error(`Permission source worker exited ${code}. ${diagnostics}`)); pending.clear(); });
    current = await ready;
    Object.assign(studio.response, { snapshot: current });
    studio.reply("POST", "/api/edits/batch/plan", async route => {
      const request = route.request().postDataJSON();
      const plan = await requestSource<BatchPlanResponse>("plan", request);
      expect(plan.ok, JSON.stringify(plan.preflight)).toBe(true);
      await route.fulfill({ json: plan });
    });
    studio.reply("POST", "/api/edits/batch/apply", async route => {
      const request = route.request().postDataJSON();
      const result = await requestSource<{ applied: ApplyResponse; snapshot: Snapshot }>("apply", request);
      current = result.snapshot;
      Object.assign(studio.response, { snapshot: current });
      await route.fulfill({ json: result.applied });
    });
    await studio.goto("/?select=lambda%3Acognito-pre-signup-trigger");
    const panel = page.getByRole("complementary", { name: "Inspector", exact: true });
    const summary = (title: string) => panel.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: new RegExp(`^${title}`) });
    await summary("Permissions").click(); await summary("Resource permissions").click();
    const policy = panel.locator("[data-slot=policy-rule]");
    await policy.locator(":scope > summary").click();
    await policy.getByRole("button", { name: "Edit policy", exact: true }).click();
    await policy.getByRole("textbox", { name: "IAM actions", exact: true }).fill("cognito-idp:ListUsers");
    await policy.getByRole("button", { name: "Stage policy changes", exact: true }).click();
    await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeEnabled({ timeout: 90_000 });
    expect(readFileSync(configFile, "utf8")).toContain("AdminLinkProviderForUser");
    await dialog.getByRole("button", { name: "Apply All", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 90_000 });
    expect(readFileSync(configFile, "utf8")).not.toContain("AdminLinkProviderForUser");
    await panel.getByRole("button", { name: "Add access", exact: true }).click();
    const stack = panel.getByRole("button", { name: /referenceExamples · CDK stack · Browse resources/ });
    await expect(stack).toContainText("not created in application.ts");
    await stack.click();
    await panel.getByRole("button", { name: /files · Amazon S3/ }).click();
    const editor = panel.getByRole("group", { name: /Access to .*files/ });
    await editor.getByRole("checkbox", { name: "Read objects", exact: true }).check();
    await editor.getByRole("button", { name: "Stage access", exact: true }).click();
    await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Apply All", exact: true })).toBeEnabled({ timeout: 90_000 });
    await dialog.getByRole("button", { name: "Apply All", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 90_000 });
    expect(readFileSync(configFile, "utf8")).toContain("resourceAccess");
    expect(current.models.dev.edges.some(edge => edge.to === "resource:referenceExamples.files" && edge.permissionContext?.kind === "resourceAccess")).toBe(true);
    const access = panel.locator("[data-slot=access-summary]").filter({ hasText: "Read objects" });
    await access.locator(":scope > summary").click();
    await expect(access).toContainText(/not (?:created|constructed)/i);
    await expect(access.getByRole("button", { name: "Edit access", exact: true })).toBeEnabled();
    await assertAccessible(page);
    await panel.screenshot({ path: info.outputPath("real-source-permissions.png"), animations: "disabled" });
    const reviewApply = async () => {
      await expect(page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true })).toBeEnabled({ timeout: 120_000 });
      await page.getByRole("dialog").getByRole("button", { name: "Apply All", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 120_000 });
    };
    for (const [kind, id] of [["Function", "gui-caller"], ["Container task", "gui-worker"]] as const) {
      await page.getByRole("button", { name: "Add to application", exact: true }).click();
      await page.getByRole("dialog", { name: "Add to application", exact: true }).getByRole("button", { name: kind, exact: true }).click();
      const creation = page.locator("dialog[open]");
      await creation.getByRole("textbox", { name: "Stable identifier", exact: true }).fill(id);
      if (kind === "Container task") await creation.getByRole("combobox", { name: "VPC", exact: true }).selectOption("application");
      await creation.getByRole("button", { name: "Review generated changes", exact: true }).click();
      await reviewApply();
      expect(current.models.dev.targets.some(item => item.ref === `${kind === "Function" ? "lambda" : "task"}:${id}`)).toBe(true);
    }
    const stageAccess = async (target: string, query: string, option: RegExp, checkbox?: string) => {
      await studio.goto(`/?select=${encodeURIComponent(target)}`);
      await summary("Permissions").click(); await summary("Resource permissions").click();
      await panel.getByRole("button", { name: "Add access", exact: true }).click();
      await panel.getByRole("searchbox", { name: "Search configured resources", exact: true }).fill(query);
      const choice = panel.getByRole("button", { name: option });
      await expect(choice).not.toHaveAttribute("aria-disabled", "true");
      await choice.click();
      if (checkbox) await panel.getByRole("checkbox", { name: checkbox, exact: true }).check();
      await panel.getByRole("button", { name: "Stage access", exact: true }).click();
      await panel.getByRole("button", { name: "Review Changes", exact: true }).click();
      await reviewApply();
    };
    await stageAccess("lambda:gui-caller", "gui-worker", /AWS Fargate · Container task/);
    await stageAccess("task:gui-worker", "files", /files · Amazon S3/, "Read objects");
    await stageAccess("lambda:gui-caller", "records", /records · Amazon DynamoDB/, "Read items");
    for (const model of Object.values(current.models)) {
      expect(model.edges.some(edge => edge.from === "lambda:gui-caller" && edge.to === "task:gui-worker" && edge.relation === "runsTask")).toBe(true);
      expect(model.edges.some(edge => edge.from === "task:gui-worker" && edge.to === "resource:referenceExamples.files" && edge.permissionContext?.kind === "resourceAccess" && edge.permissionContext.actions.join() === "read")).toBe(true);
      expect(model.edges.some(edge => edge.from === "lambda:gui-caller" && edge.to === "resource:referenceExamples.records" && edge.permissionContext?.kind === "resourceAccess" && edge.permissionContext.actions.join() === "read")).toBe(true);
    }
    expect(current.models.dev.edges.find(edge => edge.from === "lambda:gui-caller" && edge.to === "task:gui-worker" && edge.relation === "runsTask")?.readinessIssues?.some(issue => issue.blocksDeployment)).toBe(true);
    expect(current.models.prod.edges.find(edge => edge.from === "lambda:gui-caller" && edge.to === "task:gui-worker" && edge.relation === "runsTask")?.readinessIssues ?? []).toEqual([]);
  } finally {
    if (worker?.connected) await request("dispose", undefined);
    if (!path.resolve(root).startsWith(parent + path.sep)) throw new Error("Refusing cleanup outside permission fixture directory.");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  function requestSource<T>(method: string, args: unknown): Promise<T> { return request<T>(method, args); }
});
