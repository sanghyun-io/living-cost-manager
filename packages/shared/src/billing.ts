import { z } from "zod";

// Calendar dates, never UTC instants. Reject rollover dates such as February 30.
export const billingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return year >= 1900 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}, "Invalid calendar date");
export const renewalStatusSchema = z.enum(["unreviewed", "keep", "cancel-planned", "change-review", "completed"]);
export const billingFieldsSchema = z.object({
  billingAnchorDate: billingDateSchema.nullable().optional(),
  renewalStatus: renewalStatusSchema.optional(),
  potentialMonthlySavings: z.number().int().min(0).max(2147483647).optional(),
  confirmedMonthlySavings: z.number().int().min(0).max(2147483647).optional()
}).refine((item) => !item.confirmedMonthlySavings || item.renewalStatus === "completed", {
  message: "Confirmed savings require a completed review", path: ["confirmedMonthlySavings"]
});
export type BillingFields = z.infer<typeof billingFieldsSchema>;
export function summarizeRenewalSavings(items: BillingFields[]) {
  return items.reduce((total, item) => ({
    potential: total.potential + (["cancel-planned", "change-review"].includes(item.renewalStatus ?? "") ? item.potentialMonthlySavings ?? 0 : 0),
    confirmed: total.confirmed + (item.renewalStatus === "completed" ? item.confirmedMonthlySavings ?? 0 : 0)
  }), { potential: 0, confirmed: 0 });
}
