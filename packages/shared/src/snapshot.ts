import { z } from "zod";
import {
  categoryDtoSchema,
  fixedCostDtoSchema,
  paymentCardDtoSchema,
} from "./budget.js";

const idSchema = z.string().min(1);

export const workspaceSnapshotSchema = z.object({
  workspaceId: idSchema,
  // 낙관적 잠금 버전. GET 응답에 현재 값이 실려오고, PUT 요청에는 클라이언트가
  // 마지막으로 읽은 값을 그대로 실어 보낸다. 서버는 이 값이 현재 DB 값과
  // 다르면 409 로 거부한다(동시 편집 충돌).
  syncVersion: z.number().int().min(0),
  monthlyIncome: z.number().int().min(0),
  categories: z.array(categoryDtoSchema),
  cards: z.array(paymentCardDtoSchema),
  fixedCosts: z.array(fixedCostDtoSchema),
});

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
