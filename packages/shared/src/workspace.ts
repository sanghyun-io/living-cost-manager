import { z } from "zod";
import { categoryDtoSchema, paymentCardDtoSchema, fixedCostDtoSchema } from "./budget.js";
import { billingFieldsSchema } from "./billing.js";

const idSchema = z.string().min(1);

export const workspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const invitationRoleSchema = z.enum(["editor", "viewer"]);
export const workspaceInvitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const workspaceDtoSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  role: workspaceRoleSchema,
});

export const workspaceMemberDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  email: z.string().email(),
  name: z.string().min(1),
  role: workspaceRoleSchema,
});

export const workspaceInvitationDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  email: z.string().email(),
  role: invitationRoleSchema,
  status: workspaceInvitationStatusSchema,
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
});

export const createInvitationRequestSchema = z.object({
  email: z.string().email(),
  role: invitationRoleSchema.default("viewer"),
});

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(1),
});

export const updateMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
});

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type InvitationRole = z.infer<typeof invitationRoleSchema>;
export type WorkspaceInvitationStatus = z.infer<
  typeof workspaceInvitationStatusSchema
>;
export type WorkspaceDto = z.infer<typeof workspaceDtoSchema>;
export type WorkspaceMemberDto = z.infer<typeof workspaceMemberDtoSchema>;
export type WorkspaceInvitationDto = z.infer<
  typeof workspaceInvitationDtoSchema
>;
export type CreateInvitationRequestInput = z.input<
  typeof createInvitationRequestSchema
>;
export type CreateInvitationRequest = z.output<
  typeof createInvitationRequestSchema
>;
export type AcceptInvitationRequest = z.infer<
  typeof acceptInvitationRequestSchema
>;
export type UpdateMemberRoleRequest = z.infer<
  typeof updateMemberRoleRequestSchema
>;

// Browser profile IDs are not account IDs. All ownership and workspace IDs
// are assigned by the authenticated server, never copied from this payload.
const { workspaceId: _serverWorkspaceId, ...initialFixedCostShape } = fixedCostDtoSchema.shape;
const initialFixedCostSchema = billingFieldsSchema.safeExtend(initialFixedCostShape).strict();
export const initialWorkspaceBudgetSchema = z.object({
  monthlyIncome: z.number().int().min(0).max(2147483647).default(0),
  categories: z.array(categoryDtoSchema.omit({ workspaceId: true }).strict()).max(200).default([]),
  cards: z.array(paymentCardDtoSchema.omit({ workspaceId: true }).strict()).max(200).default([]),
  fixedCosts: z.array(initialFixedCostSchema).max(2000).default([]),
}).strict().superRefine((budget, ctx) => {
  for (const values of [budget.categories, budget.cards, budget.fixedCosts]) {
    if (new Set(values.map(value => value.id)).size !== values.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate budget IDs" });
    }
  }
  if (new Set(budget.categories.map(value => value.label)).size !== budget.categories.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate category labels" });
  }
  const categories = new Set(budget.categories.map(value => value.id));
  const cards = new Set(budget.cards.map(value => value.id));
  for (const cost of budget.fixedCosts) {
    if (cost.amount > 2147483647 || !categories.has(cost.categoryId) ||
        (cost.paymentMethodId === "credit-card" && cost.paymentOptionId && !cards.has(cost.paymentOptionId))) {
      ctx.addIssue({ code: "custom", message: "Invalid budget reference or amount" });
    }
  }
});
const workspaceNameSchema = z.string().trim().min(1).max(100);
export const createWorkspaceRequestSchema = z.object({
  name: workspaceNameSchema,
  initialBudget: initialWorkspaceBudgetSchema.default({ monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] }),
}).strict();
export const renameWorkspaceRequestSchema = z.object({ name: workspaceNameSchema }).strict();
export const aggregateWorkspacesRequestSchema = z.object({
  workspaceIds: z.array(z.string().min(1).max(128)).min(1).max(20)
    .transform(ids => [...new Set(ids)]),
}).strict();
export type CreateWorkspaceRequest = z.output<typeof createWorkspaceRequestSchema>;
export type RenameWorkspaceRequest = z.output<typeof renameWorkspaceRequestSchema>;
export type AggregateWorkspacesRequest = z.output<typeof aggregateWorkspacesRequestSchema>;

export type WorkspaceFinancialSummary = {
  monthlyIncome: number;
  monthlyNormalizedExpense: number;
  fixedCostCount: number;
  knownScheduleCount: number;
  unknownScheduleCount: number;
  dueOccurrenceCount: number;
  // Known charges only; null when positive costs exist but no schedule is known.
  thirtyDayDue: number | null;
};
// Ledger income may repeat the same salary across purposes. Without an income
// identity model, selected-ledger income cannot safely be summed or deduped.
export type WorkspaceAggregateTotals = Omit<WorkspaceFinancialSummary, "monthlyIncome">;
export type AggregateWorkspacesResponse = {
  currency: "KRW";
  timeZone: "Asia/Seoul";
  asOf: string;
  fromDate: string;
  untilDateExclusive: string;
  workspaces: (WorkspaceDto & WorkspaceFinancialSummary & { syncVersion: number })[];
  totals: WorkspaceAggregateTotals;
};
