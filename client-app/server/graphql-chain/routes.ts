import { Router } from "express";
import { sendJson } from "../http";
import { EditError } from "aws-studio/source/io";
import type { GraphQLChainService } from "./service";
import { GraphQLChainReviews, readChainAcceptRequest, readChainReviewRequest } from "./review";
import { studioProtocolProblem } from "../../shared/protocol";

export function graphqlChainRouter(service: GraphQLChainService): Router {
  const router = Router();
  const reviews = new GraphQLChainReviews(service);
  router.get("/", (request, response) => sendJson(response, () => {
    // Older browsers interpret local artifact states as full-chain proof. Refuse
    // their reads rather than letting them ignore the new confidence contract.
    const problem = studioProtocolProblem(request.get("x-studio-protocol"));
    if (problem) throw new EditError(409, problem);
    const check = request.query.check;
    if (Object.keys(request.query).some(key => key !== "check") || check !== undefined && check !== "fresh" && check !== "refresh") throw new EditError(400, "Choose a normal read, check=fresh, or check=refresh.");
    return service.read(check === "fresh", check === "refresh");
  }));
  router.post("/review", (request, response) => sendJson(response, () => reviews.review(readChainReviewRequest(request.body))));
  router.post("/accept", (request, response) => sendJson(response, () => reviews.accept(readChainAcceptRequest(request.body))));
  router.post("/renew", (request, response) => sendJson(response, () => reviews.renew(request.body)));
  return router;
}
