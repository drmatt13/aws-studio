import { dialogPrimaryActionClasses } from "../../inspector-ui";
import { buttonClasses } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { WorkbenchDialog } from "../WorkbenchUI";

/** The workspace's "How this works", composed like Database's. */
export function GraphQLHelp({ onClose }: { readonly onClose: () => void }) {
  return <WorkbenchDialog id="graphql-workbench-help" size="help" title="How this works" onClose={onClose} footer={
    <button data-variant="primary" className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))} onClick={onClose}>Got it</button>
  }>
    <p data-ui="workbench-help-flow" className="m-0 text-label leading-[1.65] font-medium text-graphite">Database contract → Pothos schema → generated GraphQL → client operations</p>
    <p className="m-0 text-label leading-[1.65]"><strong>Draft full contract task</strong>, <strong>Draft Pothos task</strong> and <strong>Draft client task</strong> open editable requests in Coding. Choose <strong>Start coding task</strong> to begin.</p>
    <ol className="m-0 grid gap-3 pl-5 text-body leading-[1.65]">
      <li className="pl-1"><strong>Pothos review</strong> checks the database artifacts, repository behavior, and API implementation. Studio keeps private fields private and asks for evidence if a change needs a new application decision.</li>
      <li className="pl-1"><strong>Regenerate GraphQL</strong> runs the project’s generator using the saved GraphQL schema, operations and fragments. Resolve any reported source errors before retrying.</li>
      <li className="pl-1"><strong>Client review</strong> checks selections, query options, cache behavior, and consumer compatibility before recording approval.</li>
    </ol>
    <p className="m-0 text-label leading-[1.65]">Recording a review writes only <code>graphql-chain.review.json</code>. <strong>Check again</strong> reads saved source; it never contacts a running API, AWS or a database.</p>
    <p className="m-0 text-label leading-[1.65]"><strong>In sync</strong> means the upstream output matches this stage’s recorded input. <strong>Approved</strong> also requires a matching saved approval. When Codegen needs regeneration, the client waits for the generated files.</p>
    <p className="m-0 text-label leading-[1.65]"><strong>Proof lineage</strong> shows each stage’s current and historical receipts, predecessor bindings, validation policy, checks and accepted decisions. Stored receipts cannot replace current verification. CI independently runs the required checks; a recorded CI comparison is an observation, not a signature.</p>
    <p className="m-0 text-label leading-[1.65] text-graphite">Candidate receipts describe the private workspace. Recorded approvals require passing saved-source checks. Explorer runs an operation against this checkout’s local API only when you press Run.</p>
  </WorkbenchDialog>;
}
