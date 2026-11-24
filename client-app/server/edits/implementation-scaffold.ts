import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ScaffoldTemplateId } from "aws-studio/scaffolding";
import type { ModelTarget } from "../../shared/model";
import { assertCreationFile } from "./creation";
import { EditError } from "aws-studio/source/io";
import { assertWorkspaceDirectory } from "./workspace";
import { renderStarter } from "./scaffolding";
import { findDockerfile } from "aws-studio/config/source";

/** The same factory as creation, adding only missing files at the actual declared path. */
export function planImplementation(root: string, target: ModelTarget) {
  if (!target.directory || target.kind === "workflow") throw new EditError(422, "This declaration has no implementation directory.");
  const directory = target.directory;
  let template: ScaffoldTemplateId;
  let handler = "lambdaHandler";
  if (target.kind === "agent") template = "agent/respond";
  else if (target.compute.kind === "container") {
    const manifest = assertCreationFile(root, `${directory}/package.json`);
    const dockerfile = findDockerfile(path.join(root, directory));
    if (dockerfile && lstatSync(dockerfile).isSymbolicLink()) throw new EditError(422, "Creation cannot read a starter Dockerfile through symbolic links.");
    const legacy = existsSync(assertCreationFile(root, `${directory}/index.mjs`)) || !existsSync(assertCreationFile(root, `${directory}/src/index.ts`)) && [manifest, dockerfile].some(file => file && existsSync(file) && /\bindex\.mjs\b/.test(readFileSync(file, "utf8")));
    template = target.kind === "service" ? legacy ? "container-service/legacy-javascript" : "container-service" : legacy ? "container-task/legacy-javascript" : "container-task";
  } else if (target.compute.kind === "lambda") {
    const compute = target.compute;
    if (compute.packaging === "container") throw new EditError(422, "An image Lambda needs a compatible runtime Dockerfile and handler. Existing code is preserved; implement the image at the configured source link, then refresh. Studio's repair currently supports Node/Python ZIP handlers and ECS images.");
    if (compute.implementation === "python") {
      if (target.auth) throw new EditError(422, "Authenticated Python handlers need their source-owned token verifier. Open the implementation and restore that verifier; Studio will not substitute an unauthenticated starter.");
      if (compute.handler !== "lambda_function.lambda_handler") throw new EditError(422, "Custom Python entry points remain source-owned. Create lambda_function.py and the configured callable in your editor.");
      template = "lambda/python";
    } else {
      handler = compute.handler ?? "lambdaHandler";
      if (!/^[A-Za-z_$][\w$]*$/.test(handler)) throw new EditError(422, "Create the custom handler entry point in source.");
      template = target.role === "tool" ? target.auth ? "tool/authenticated" : "tool/public"
        : target.role === "http" ? target.auth ? "lambda/http-authenticated" : "lambda/http"
        : target.role === "webSocket" ? "lambda/websocket"
        : compute.localReplay ? "lambda/event" : "lambda/event-result";
    }
  } else throw new EditError(422, "This workload has no supported implementation template.");
  const rendered = renderStarter(root, template, { id: target.id, directory, handler, ...(target.compute.kind === "container" ? { port: target.compute.port, healthCheckPath: target.compute.healthCheckPath } : {}) });
  const files = new Map<string, string>();
  for (const [name, text] of rendered.files) {
    const file = assertCreationFile(root, `${directory}/${name}`);
    if (existsSync(file)) continue;
    if (name === "Dockerfile" && findDockerfile(path.join(root, directory))) continue;
    if (name === "package.json") assertWorkspaceDirectory(root, directory);
    files.set(file, text);
  }
  if ((template === "container-service" || template === "container-task") && files.has(path.join(root, directory, "Dockerfile"))) {
    const manifest = assertCreationFile(root, `${directory}/package.json`);
    if (existsSync(manifest) && typeof JSON.parse(readFileSync(manifest, "utf8")).scripts?.build !== "string") throw new EditError(422, "This existing container workspace has no build script for the TypeScript starter Dockerfile. Restore its compatible Dockerfile in source; existing code and package.json were preserved.");
  }
  if (!files.size) throw new EditError(422, "All starter files already exist. Existing code was preserved; inspect its diagnostics or continue in source.");
  return { files, templates: [rendered.snapshot] };
}
