ALTER TABLE "ClassBooking" ADD COLUMN "classProductId" TEXT;

UPDATE "ClassBooking" AS booking
SET "classProductId" = session."classProductId"
FROM "ClassSession" AS session
WHERE booking."classSessionId" = session."id";

ALTER TABLE "ClassBooking" ALTER COLUMN "classProductId" SET NOT NULL;
ALTER TABLE "ClassBooking" ALTER COLUMN "classSessionId" DROP NOT NULL;

ALTER TABLE "ClassBooking" DROP CONSTRAINT "ClassBooking_classSessionId_fkey";

CREATE INDEX "ClassBooking_classProductId_idx" ON "ClassBooking"("classProductId");

ALTER TABLE "ClassBooking"
ADD CONSTRAINT "ClassBooking_classProductId_fkey"
FOREIGN KEY ("classProductId") REFERENCES "ClassProduct"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassBooking"
ADD CONSTRAINT "ClassBooking_classSessionId_fkey"
FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
