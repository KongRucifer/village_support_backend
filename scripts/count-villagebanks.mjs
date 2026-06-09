// Quick check: how many rows are in villagebank vs vbcode.
// Run:  node scripts/count-villagebanks.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

try {
  const villageBanks = await prisma.villageBank.count();
  const vbCodes = await prisma.vbCode.count();
  const vbCodesWithBank = await prisma.vbCode.count({
    where: { villageBank: { isNot: null } },
  });

  console.log('villagebank table rows    :', villageBanks);
  console.log('vbcode table rows         :', vbCodes);
  console.log('vbcode WITH a villagebank :', vbCodesWithBank);
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await prisma.$disconnect();
}
