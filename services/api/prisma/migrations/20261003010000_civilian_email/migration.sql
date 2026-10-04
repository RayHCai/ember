-- DropIndex
DROP INDEX "civilians_phone_key";

-- AlterTable
ALTER TABLE "civilians" DROP COLUMN "phone",
ADD COLUMN     "email" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "civilians_email_key" ON "civilians"("email");
