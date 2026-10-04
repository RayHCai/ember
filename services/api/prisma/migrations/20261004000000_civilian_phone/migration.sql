-- DropIndex
DROP INDEX "civilians_email_key";

-- AlterTable
ALTER TABLE "civilians" DROP COLUMN "email",
ADD COLUMN     "phone" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "civilians_phone_key" ON "civilians"("phone");
