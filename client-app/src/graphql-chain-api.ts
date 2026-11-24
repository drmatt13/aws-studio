import type { AcceptRequest, AcceptResult, ContractRenewalRequest, ContractRenewalResult, GraphQLChain, ReviewPlan, ReviewRequest } from "aws-studio/contract-chain/graphql-chain";
import { STUDIO_RESTART_MESSAGE } from "../shared/protocol";
import { isGraphQLChainResponse } from "aws-studio/contract-chain/graphql-chain-response";
import { ApiError, call } from "./http";

/** A new browser must not interpret an older server's independent green states as proof. */
export function readGraphQLChain(value: unknown): GraphQLChain {
  if (!isGraphQLChainResponse(value)) {
    throw new ApiError(409, STUDIO_RESTART_MESSAGE);
  }
  return value;
}

/** Source evidence only; checking the chain never generates or applies anything. */
export const graphqlChainApi = {
  load: async (signal?: AbortSignal, freshness: "cached" | "fresh" | "refresh" = "cached") =>
    readGraphQLChain(await call<unknown>(`/graphql/chain${freshness === "cached" ? "" : `?check=${freshness}`}`, undefined, signal)),
  review: (request: ReviewRequest) => call<ReviewPlan>("/graphql/chain/review", request),
  accept: (request: AcceptRequest) => call<AcceptResult>("/graphql/chain/accept", request),
  renew: (request: ContractRenewalRequest, signal?: AbortSignal) => call<ContractRenewalResult>("/graphql/chain/renew", request, signal),
};
