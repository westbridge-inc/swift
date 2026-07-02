-- Staff & roles (master plan §4.1): multiple logins per store with role-based
-- permissions. Owners invite existing Swift accounts by phone.
CREATE TYPE "VendorStaffRole" AS ENUM ('MANAGER', 'STAFF');

CREATE TABLE "vendor_staff" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "VendorStaffRole" NOT NULL DEFAULT 'STAFF',
    "invitedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_staff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_staff_vendorId_userId_key" ON "vendor_staff"("vendorId", "userId");

ALTER TABLE "vendor_staff" ADD CONSTRAINT "vendor_staff_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_staff" ADD CONSTRAINT "vendor_staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
