-- [R048-006] A platform page (scheduler stall, boot contract) is an OpsAlert row before it is a notification.
ALTER TYPE "OpsAlertKind" ADD VALUE IF NOT EXISTS 'PLATFORM';
