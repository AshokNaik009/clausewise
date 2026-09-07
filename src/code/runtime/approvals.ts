import { z } from "zod";

const actionSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
});
const decisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }).strict(),
  z.object({ type: z.literal("reject"), message: z.string().optional() }).strict(),
]);
export const requestSchema = z.object({
  id: z.string().min(1),
  value: z.object({
    actionRequests: z.array(actionSchema).min(1),
    reviewConfigs: z.array(z.object({
      actionName: z.string(),
      allowedDecisions: z.array(z.enum(["approve", "reject", "edit"])).min(1),
    })).min(1),
  }),
});

export type ApprovalRequest = z.infer<typeof requestSchema>;
export type ApprovalDecision = z.infer<typeof decisionSchema>;
export type ApprovalDecisions = Record<string, ApprovalDecision[]>;
export const GATED_TOOLS = ["execute", "write_file", "edit_file", "delete", "task", "web_search", "fetch_url"] as const;

export function createInterruptPolicy(): Record<string, { allowedDecisions: ("approve" | "reject")[] }> {
  return Object.fromEntries(GATED_TOOLS.map((name) => [name, { allowedDecisions: ["approve", "reject"] }]));
}

export function approvalRequests(values: unknown): ApprovalRequest[] {
  const requests = z.array(requestSchema).parse(values);
  if (new Set(requests.map(({ id }) => id)).size !== requests.length) throw new Error("Duplicate approval interrupt IDs");
  for (const { value } of requests) {
    if (value.actionRequests.length !== value.reviewConfigs.length || value.actionRequests.some((action, index) => action.name !== value.reviewConfigs[index]?.actionName)) {
      throw new Error("Approval actions do not match their review policies");
    }
  }
  return requests;
}

export function parseApprovalDecisions(input: unknown): ApprovalDecisions {
  return z.record(z.string(), z.array(decisionSchema)).parse(input);
}

export function approvalResume(requests: ApprovalRequest[], input: unknown): Record<string, { decisions: ApprovalDecision[] }> {
  const decisions = parseApprovalDecisions(input);
  if (Object.keys(decisions).length !== requests.length) throw new Error("Provide decisions for exactly the pending approval IDs");
  return Object.fromEntries(requests.map(({ id, value }) => {
    const selected = decisions[id];
    if (!Object.hasOwn(decisions, id) || selected?.length !== value.actionRequests.length) throw new Error("Provide one decision per pending action");
    if (selected.some((decision, index) => !value.reviewConfigs[index]?.allowedDecisions.includes(decision.type))) {
      throw new Error("Decision is not allowed by the pending approval policy");
    }
    return [id, { decisions: selected }];
  }));
}
