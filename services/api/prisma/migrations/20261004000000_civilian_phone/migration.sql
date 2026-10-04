-- AlterTable
ALTER TABLE "civilians" ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "civilians_phone_key" ON "civilians"("phone");
