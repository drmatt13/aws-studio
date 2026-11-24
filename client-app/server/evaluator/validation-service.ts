import { fileURLToPath } from "node:url";
import type { StatefulResourcesConfiguration } from "aws-studio/deploy/stateful-resources";
import type { assertDatabaseReference, CognitoReference, validateCognitoReference } from "aws-studio/deploy/stateful-references";
import { EditError } from "aws-studio/source/io";
import type { Mode } from "../../shared/model";
import { resolveProjectInstallation } from "../project-release";
import { projectRuntime } from "../project-runtime";
import { launchInspection } from "./inspection-process";

export type ValidationRequest =
  | { readonly kind: "policy"; readonly value: StatefulResourcesConfiguration; readonly mode: Mode }
  | { readonly kind: "cognito"; readonly reference: CognitoReference; readonly destination: Parameters<typeof validateCognitoReference>[1] }
  | { readonly kind: "database"; readonly reference: unknown; readonly destination: Parameters<typeof assertDatabaseReference>[1] };
export type ValidationReply = { readonly ok: true } | { readonly ok: false; readonly message: string };

const ENTRY = fileURLToPath(new URL("./validation-worker.ts", import.meta.url));

/** Run only fixed framework validators and return a value-free result. */
export function validateProjectDeclaration(root: string, request: ValidationRequest): Promise<void> {
  resolveProjectInstallation(root);
  const child = launchInspection(ENTRY, root, projectRuntime(root));
  child.stdout?.resume();
  child.stderr?.resume();
  return new Promise((resolve, reject) => {
    let reply: ValidationReply | undefined;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("message", value => { reply = value as ValidationReply; });
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer);
      if (reply?.ok === true) resolve();
      else reject(new EditError(422, reply?.message?.slice(0, 1000) ?? "The project framework did not finish validating this declaration."));
    });
    child.send(request, error => { if (error) { reject(error); child.kill(); } });
  });
}
