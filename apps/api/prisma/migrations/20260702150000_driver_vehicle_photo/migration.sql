-- Trust visibility on tracking (master plan §3.3 + §5): the customer sees the
-- vehicle before it arrives. Public photos, uploaded in the earner app.
ALTER TABLE "drivers" ADD COLUMN     "vehiclePhotoUrl" TEXT;
ALTER TABLE "riders" ADD COLUMN     "vehiclePhotoUrl" TEXT;
