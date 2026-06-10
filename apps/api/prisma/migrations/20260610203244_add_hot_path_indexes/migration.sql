-- CreateIndex
CREATE INDEX "earnings_status_idx" ON "earnings"("status");

-- CreateIndex
CREATE INDEX "earnings_riderId_idx" ON "earnings"("riderId");

-- CreateIndex
CREATE INDEX "earnings_driverId_idx" ON "earnings"("driverId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");

-- CreateIndex
CREATE INDEX "orders_customerId_idx" ON "orders"("customerId");

-- CreateIndex
CREATE INDEX "orders_vendorId_idx" ON "orders"("vendorId");

-- CreateIndex
CREATE INDEX "orders_riderId_idx" ON "orders"("riderId");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_placedAt_idx" ON "orders"("placedAt");

-- CreateIndex
CREATE INDEX "orders_customerId_status_idx" ON "orders"("customerId", "status");

-- CreateIndex
CREATE INDEX "riders_isOnline_idx" ON "riders"("isOnline");

-- CreateIndex
CREATE INDEX "riders_isOnline_isAvailable_idx" ON "riders"("isOnline", "isAvailable");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_nextBillingDate_idx" ON "subscriptions"("nextBillingDate");

-- CreateIndex
CREATE INDEX "transactions_userId_idx" ON "transactions"("userId");

-- CreateIndex
CREATE INDEX "transactions_createdAt_idx" ON "transactions"("createdAt");

-- CreateIndex
CREATE INDEX "vendors_status_idx" ON "vendors"("status");

-- CreateIndex
CREATE INDEX "vendors_vendorType_idx" ON "vendors"("vendorType");

-- CreateIndex
CREATE INDEX "vendors_latitude_longitude_idx" ON "vendors"("latitude", "longitude");
