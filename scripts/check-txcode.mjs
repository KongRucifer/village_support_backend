// Verify transaction_code 6607 exists (else withdraw won't create a tx row).
// Run:  node scripts/check-txcode.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

try {
  for (const code of ['3101', '6607']) {
    const row = await prisma.transactionCode.findUnique({
      where: { transactionCode: code },
      select: { transactionCode: true, nameLao: true, nameEng: true },
    });
    const txCount = await prisma.transactions.count({
      where: { transactionCodeId: code },
    });
    console.log(`code ${code}: exists=${row ? 'YES' : 'NO'} ` +
      `name="${row?.nameLao ?? row?.nameEng ?? '-'}" txRows=${txCount}`);
  }
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await prisma.$disconnect();
}
