import { z } from "zod";

const idSchema = z.string().min(1);
const billingDaySchema = z.number().int().min(1).max(31);

export const roundPeriodMonths = (value: number) =>
  Math.round((value + Number.EPSILON) * 10) / 10;

const isRoundedToFirstDecimal = (value: number) =>
  Object.is(value, roundPeriodMonths(value));

export const paymentMethodIdSchema = z.enum([
  "cash",
  "bank-transfer",
  "debit-card",
  "credit-card",
  "other",
]);

export const categoryDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  label: z.string().min(1),
});

export const paymentCardDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  label: z.string().min(1),
  billingDay: billingDaySchema,
});

export const fixedCostDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1),
  categoryId: idSchema,
  paymentMethodId: paymentMethodIdSchema,
  paymentOptionId: z.string(),
  amount: z.number().int().min(0),
  periodMonths: z
    .number()
    .min(1)
    .max(120)
    .refine(isRoundedToFirstDecimal, "Expected number rounded to one decimal"),
  billingDay: billingDaySchema,
});

export type PaymentMethodId = z.infer<typeof paymentMethodIdSchema>;
export type CategoryDto = z.infer<typeof categoryDtoSchema>;
export type PaymentCardDto = z.infer<typeof paymentCardDtoSchema>;
export type FixedCostDto = z.infer<typeof fixedCostDtoSchema>;
