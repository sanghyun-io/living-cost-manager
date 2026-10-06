CREATE TABLE "BudgetTemplate" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "blueprint" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BudgetTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BudgetTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BudgetTemplate_userId_idx" ON "BudgetTemplate"("userId");
CREATE TABLE "BudgetTemplateShare" (
  "templateId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "blueprint" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "BudgetTemplateShare_pkey" PRIMARY KEY ("templateId"),
  CONSTRAINT "BudgetTemplateShare_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "BudgetTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BudgetTemplateShare_token_key" ON "BudgetTemplateShare"("token");
