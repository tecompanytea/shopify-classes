-- CreateTable
CREATE TABLE "ClassBooking" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "lineItemGid" TEXT NOT NULL,
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT,
    "customerGid" TEXT,
    "customerName" TEXT,
    "customerOrdersCount" INTEGER,
    "customerLocation" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "variantGid" TEXT,
    "productGid" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassBooking_shop_lineItemGid_key" ON "ClassBooking"("shop", "lineItemGid");

-- CreateIndex
CREATE INDEX "ClassBooking_shop_orderGid_idx" ON "ClassBooking"("shop", "orderGid");

-- CreateIndex
CREATE INDEX "ClassBooking_shop_orderCreatedAt_idx" ON "ClassBooking"("shop", "orderCreatedAt");

-- CreateIndex
CREATE INDEX "ClassBooking_classSessionId_idx" ON "ClassBooking"("classSessionId");

-- AddForeignKey
ALTER TABLE "ClassBooking" ADD CONSTRAINT "ClassBooking_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
