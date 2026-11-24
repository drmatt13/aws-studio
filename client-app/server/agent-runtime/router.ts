import express from "express";
import type { CodingOwnershipReview, CodingProposal } from "../../shared/agent-runtime";
import type { AgentTaskClient } from "./client";
import { AgentRuntimeError } from "./store";
import { sendJson } from "../http";

/** Already-approved proposals: their retries re-approve the same digest after the source legitimately changed. */
const SETTLED = new Set(["integrating", "completed", "recovery_required"]);

/**
 * Mounted behind Studio's Host, Origin, token and protocol guards. `ownership` checks a proposal
 * against the Studio graph: shown with the proposal, and enforced before the host is asked to approve.
 */
export function agentTaskRouter(client: AgentTaskClient, ownership: (proposal: CodingProposal) => CodingOwnershipReview) {
  const router = express.Router();
  router.get("/", (_request, response) => sendJson(response, () => client.list()));
  router.post("/", (request, response) => sendJson(response, () => client.submit(request.body)));
  router.get("/runtime-upgrade", (_request, response) => sendJson(response, () => client.runtimeUpgrade()));
  router.post("/runtime-upgrade", (request, response) => sendJson(response, () => client.restartHost(String(request.body?.requestId ?? ""), request.body?.replaceFailedRequestId === undefined ? undefined : String(request.body.replaceFailedRequestId))));
  router.get("/recovery", (_request, response) => sendJson(response, () => client.recovery()));
  router.post("/recovery/:id", (request, response) => sendJson(response, () => client.recover(String(request.params.id), request.body)));
  router.get("/:id", (request, response) => sendJson(response, () => client.get(String(request.params.id))));
  router.get("/:id/events", (request, response) => sendJson(response, () => client.events(String(request.params.id), Number(request.query.after ?? 0))));
  router.get("/:id/proposal", (request, response) => sendJson(response, async () => {
    const proposal = await client.proposal(String(request.params.id));
    return { ...proposal, ownership: ownership(proposal) };
  }));
  router.post("/:id/approve", (request, response) => sendJson(response, async () => {
    const id = String(request.params.id);
    if (!SETTLED.has((await client.get(id)).status)) {
      const proposal = await client.proposal(id);
      if (String(request.body?.digest ?? "") !== proposal.digest) throw new AgentRuntimeError(409, "Review the current proposal before approval.");
      const review = ownership(proposal);
      if (review.refusal) throw new AgentRuntimeError(422, `Studio did not approve this proposal: ${review.refusal}`);
    }
    return client.action(id, "approve", request.body);
  }));
  router.post("/:id/activate", (request, response) => sendJson(response, () => client.activate(String(request.params.id), String(request.body?.digest ?? ""))));
  for (const action of ["cancel", "resume", "continue", "reject", "refresh", "cleanup"] as const) router.post(`/:id/${action}`, (request, response) => sendJson(response, () => client.action(String(request.params.id), action, request.body)));
  router.post("/:id/permissions/:requestId", (request, response) => sendJson(response, () => client.permission(String(request.params.id), String(request.params.requestId), request.body)));
  return router;
}
