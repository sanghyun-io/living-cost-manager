import { z } from "zod";
import {
  categoryDtoSchema,
  fixedCostDtoSchema,
  paymentCardDtoSchema,
} from "./budget.js";

const idSchema = z.string().min(1);

export const workspaceSnapshotSchema = z.object({
  workspaceId: idSchema,
  monthlyIncome: z.number().int().min(0),
  categories: z.array(categoryDtoSchema),
  cards: z.array(paymentCardDtoSchema),
  fixedCosts: z.array(fixedCostDtoSchema),
});

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
