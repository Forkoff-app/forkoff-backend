-- Drop tables (order matters for foreign keys)
DROP TABLE IF EXISTS "VoucherRedemption";
DROP TABLE IF EXISTS "Voucher";
DROP TABLE IF EXISTS "Referral";
DROP TABLE IF EXISTS "ReferralProfile";
DROP TABLE IF EXISTS "PhoneSession";
DROP TABLE IF EXISTS "SubscriptionUsage";

-- Drop Voucher system enums
DROP TYPE IF EXISTS "VoucherType";
DROP TYPE IF EXISTS "VoucherBenefitType";

-- Drop User subscription fields
ALTER TABLE "User" DROP COLUMN IF EXISTS "subscription";
ALTER TABLE "User" DROP COLUMN IF EXISTS "proExpiresAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "isLifetimePro";
ALTER TABLE "User" DROP COLUMN IF EXISTS "stripeCustomerId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "stripeSubscriptionId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "stripePriceId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "stripeCurrentPeriodEnd";
ALTER TABLE "User" DROP COLUMN IF EXISTS "appleOriginalTransactionId";
