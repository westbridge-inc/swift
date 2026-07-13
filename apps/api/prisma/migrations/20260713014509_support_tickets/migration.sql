-- CreateEnum
CREATE TYPE "SupportCategory" AS ENUM ('ORDER_ISSUE', 'PAYMENT', 'SAFETY', 'ACCOUNT', 'VENDOR', 'MOVER', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "category" "SupportCategory" NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "adminNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_tickets_userId_idx" ON "support_tickets"("userId");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "support_tickets_orderId_idx" ON "support_tickets"("orderId");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

