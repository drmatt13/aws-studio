import { assertScaffoldUnchanged, renderScaffold, type ScaffoldParameters, type ScaffoldSnapshot, type ScaffoldTemplateId } from "aws-studio/scaffolding";
import { EditError } from "aws-studio/source/io";

export function renderStarter(root: string, id: ScaffoldTemplateId, parameters: ScaffoldParameters) {
  try { return renderScaffold(root, id, parameters); }
  catch (error) { throw new EditError(422, error instanceof Error ? error.message : "The implementation template could not be rendered."); }
}
export function assertStartersUnchanged(root: string, templates: readonly ScaffoldSnapshot[] = []): void {
  for (const template of templates) {
    try { assertScaffoldUnchanged(root, template); }
    catch (error) { throw new EditError(409, error instanceof Error ? error.message : "The implementation template changed after review."); }
  }
}
