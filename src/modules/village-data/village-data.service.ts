import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PaginatedResult } from '../../common/dto/pagination.dto.js';
import {
  getPrismaPagination,
  createPrismaPaginatedResponse,
} from '../../common/utils/prisma-pagination.util.js';
import { VbCodeQueryDto, AccountOwnerQueryDto } from './dto/vbcode-query.dto.js';
import { UpdateSavingsDto } from './dto/update-savings.dto.js';
import { PaymentMethod, WithdrawDto } from './dto/withdraw.dto.js';
import { CheckInDto } from './dto/checkin.dto.js';
import { randomUUID } from 'crypto';
import { PaginationDto } from '../../common/dto/pagination.dto.js';

// Savings withdrawal / disbursement transaction code (see TransactionsService.SAVINGS_TX_CODES).
const SAVINGS_WITHDRAW_TX_CODE = '6607';

// Fixed deposit amount added to a member's savings balance on check-in.
const CHECK_IN_DEPOSIT = 195000;

/** Shape returned for a single village bank (vbcode) row. */
export interface VbCodeListItem {
  vbCode: string;
  nameLao: string;
  nameEng: string;
  provinceId: string;
  provinceName: string | null;
  districtId: string;
  districtName: string | null;
  villageBankName: string | null;
  foundingDate: Date | null;
  statusId: string | null;
  clientCount: number;
  accountOwnerCount: number;
  /** Sum of this village bank's cash-account family ('110' tree) balances.
   *  Only populated by the sync snapshot (used by the offline no-cash guard). */
  cashBalance?: number;
}

/** Shape returned for one account owner (account_owner joined with client + account). */
export interface AccountOwnerItem {
  bankbookNumber: string;
  accNumber: string;
  vbCode: string;
  clientId: string;
  clientName: string; // resolved name instead of the raw id
  accNameLao: string | null;
  accNameEng: string | null;
  currentBalance: number;
  accountType: string | null;
  statusId: string | null;
  /** Accumulated unpaid equity-saving balance (sum of all arrangement rows for
   *  this account+vbCode). Used by the checkout "overdue" card. */
  overduePayment?: number;
  /** Number of unpaid check-ins (vbc_arrangement rows with need_sync = 'i'). */
  overdueCount?: number;
}

/** One check-in / check-out row from vbc_arrangement (for offline sync). */
export interface CheckinSyncItem {
  bankbookNumber: string | null;
  vbCode: string;
  date: string;           // 'YYYY-MM-DD'
  points: number | null;  // 1 = checked in, 0 = checked out
  needSync: string | null; // 'i' = checked in, 'u' = checked out
  lastUpdate: string | null; // ISO timestamp
}

/** One id_document row (for offline lookup-by-document-number). */
export interface IdDocumentSyncItem {
  id: string;                  // BigInt id as string (stable primary key)
  idDocumentNumber: string;
  clientId: string;
  vbCode: string | null;
  documentNameLao: string | null;
  documentNameEng: string | null;
}

/** One transaction row (tx 3101) for offline payment history. */
export interface TransactionSyncItem {
  id: string;
  date: string;                 // ISO timestamp
  bankbookNumber: string | null;
  transactionCodeId: string;
  txNameLao: string | null;
  txNameEng: string | null;
  amount: number;
  debitAccNumber: string;
  debitAccNameLao: string | null;
  creditAccNumber: string;
  description: string | null;
  paymentMethod: string | null;
  vbCode: string;
}

/** Format a Date as 'YYYY-MM-DD' using UTC components.
 *  Date-only values are stored as UTC-midnight (see [utcDateOnly]), so reading
 *  them back with UTC getters yields the correct calendar day. */
function ymd(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** Build a UTC-midnight Date for the LOCAL calendar day of [d].
 *  Postgres `@db.Date` columns store the UTC date part, so using local midnight
 *  (`new Date(y, m, d)`) shifts back one day in UTC+ timezones. Anchoring to
 *  `Date.UTC` keeps the stored date equal to the server's local calendar day. */
function utcDateOnly(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

@Injectable()
export class VillageDataService {
  private readonly logger = new Logger(VillageDataService.name);

  constructor(private readonly prisma: PrismaService) {}

  private fullName(c: {
    firstName: string | null;
    lastName: string | null;
    nickName: string | null;
  }): string {
    const parts = [c.firstName, c.lastName].filter(Boolean);
    if (parts.length) return parts.join(' ');
    return c.nickName ?? '(no name)';
  }

  /** Compute the overdue summary for one account:
   *  - overduePayment: SUM(current_balance) of every client_equity_saving_arrangement
   *    row for this account+vbCode (the full accumulated unpaid amount).
   *  - overdueCount:   number of vbc_arrangement rows for this member (bankbook+vbcode)
   *    still flagged need_sync = 'i' (checked in but not yet paid out). */
  private async overdueFor(acc: {
    accNumber: string;
    vbCode: string;
    bankbookNumber: string | null;
  }): Promise<{ overduePayment: number; overdueCount: number }> {
    const [sumAgg, count] = await Promise.all([
      this.prisma.clientEquitySavingArrangement.aggregate({
        _sum: { currentBalance: true },
        where: { accNumber: acc.accNumber, vbCode: acc.vbCode },
      }),
      this.prisma.vbc_arrangement.count({
        where: {
          vbcode: acc.vbCode.trim(),
          bankbooknumber: acc.bankbookNumber?.trim() ?? null,
          need_sync: 'i',
        },
      }),
    ]);
    return {
      overduePayment: Number(sumAgg._sum.currentBalance ?? 0n),
      overdueCount: count,
    };
  }

  // ── 3g. Overdue payment summary for one account ─────────────────────────────
  /** Returns the total overdue (sum of equity-saving current_balance) and the
   *  count of unpaid check-ins. Drives the checkout screen's "overdue" card. */
  async getOverdue(
    accNumber: string,
    vbCode?: string,
  ): Promise<{ overduePayment: number; countOverduePayment: number }> {
    const account = await this.prisma.accounts.findUnique({
      where: { accNumber: accNumber.trim() },
      select: { accNumber: true, vbCode: true, bankbookNumber: true },
    });
    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account ${accNumber} not found`,
      });
    }
    if (vbCode && vbCode.trim() !== account.vbCode.trim()) {
      throw new BadRequestException({
        code: 'VB_MISMATCH',
        message: 'vbCode does not match this account',
      });
    }
    const { overduePayment, overdueCount } = await this.overdueFor(account);
    // Return the BACKLOG count (excludes the current period): one less than the
    // raw number of unpaid check-ins, floored at 0. The client hides the overdue
    // UI when this is <= 0.
    return { overduePayment, countOverduePayment: Math.max(0, overdueCount - 1) };
  }

  // ── 1. VbCode list — paginated + search by code / name ──────────────────────
  async listVbCodes(query: VbCodeQueryDto): Promise<PaginatedResult<VbCodeListItem>> {
    const { skip, take, page, limit } = getPrismaPagination(query.page, query.limit);
    const search = query.search?.trim();

    // Only ACTIVE village banks: a vbcode row whose villagebank has status_id '2'.
    // (The vbcode table holds 9235 administrative codes; only operating banks have
    // a villageBank relation, and of those we show only the active ones.)
    const where: any = { villageBank: { statusId: '2' } };
    if (search) {
      where.OR = [
        { id: { contains: search, mode: 'insensitive' as const } },
        { nameLao: { contains: search, mode: 'insensitive' as const } },
        { nameEng: { contains: search, mode: 'insensitive' as const } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.vbCode.findMany({
        where,
        skip,
        take,
        orderBy: { id: 'asc' },
        include: {
          province: { select: { nameLao: true, nameEng: true } },
          district: { select: { nameLao: true, nameEng: true } },
          villageBank: { select: { nameLao: true, foundingDate: true, statusId: true } },
          _count: { select: { clients: true, accountOwners: true } },
        },
      }),
      this.prisma.vbCode.count({ where }),
    ]);

    const results: VbCodeListItem[] = rows.map((r) => ({
      vbCode: r.id,
      nameLao: r.nameLao,
      nameEng: r.nameEng,
      provinceId: r.provinceId,
      provinceName: r.province?.nameLao ?? r.province?.nameEng ?? null,
      districtId: r.districtId,
      districtName: r.district?.nameLao ?? r.district?.nameEng ?? null,
      villageBankName: r.villageBank?.nameLao ?? null,
      foundingDate: r.villageBank?.foundingDate ?? null,
      statusId: r.villageBank?.statusId ?? null,
      clientCount: r._count.clients,
      accountOwnerCount: r._count.accountOwners,
    }));

    return createPrismaPaginatedResponse(results, total, page, limit, 'VbCodes fetched successfully');
  }

  // ── 2. Single VbCode detail ─────────────────────────────────────────────────
  async getVbCode(vbCode: string): Promise<VbCodeListItem> {
    const r = await this.prisma.vbCode.findUnique({
      where: { id: vbCode },
      include: {
        province: { select: { nameLao: true, nameEng: true } },
        district: { select: { nameLao: true, nameEng: true } },
        villageBank: { select: { nameLao: true, foundingDate: true, statusId: true } },
        _count: { select: { clients: true, accountOwners: true } },
      },
    });

    if (!r) {
      throw new NotFoundException(`VbCode ${vbCode} not found`);
    }

    return {
      vbCode: r.id,
      nameLao: r.nameLao,
      nameEng: r.nameEng,
      provinceId: r.provinceId,
      provinceName: r.province?.nameLao ?? r.province?.nameEng ?? null,
      districtId: r.districtId,
      districtName: r.district?.nameLao ?? r.district?.nameEng ?? null,
      villageBankName: r.villageBank?.nameLao ?? null,
      foundingDate: r.villageBank?.foundingDate ?? null,
      statusId: r.villageBank?.statusId ?? null,
      clientCount: r._count.clients,
      accountOwnerCount: r._count.accountOwners,
    };
  }

  // ── 3. AccountOwner list — by vbCode (+ optional bankbookNumber) ─────────────
  async listAccountOwners(
    query: AccountOwnerQueryDto,
  ): Promise<PaginatedResult<AccountOwnerItem>> {
    const { skip, take, page, limit } = getPrismaPagination(query.page, query.limit);

    const where: any = {};
    if (query.vbCode?.trim()) where.vbCode = query.vbCode.trim();
    if (query.bankbookNumber?.trim()) where.bankbookNumber = query.bankbookNumber.trim();

    const [rows, total] = await Promise.all([
      this.prisma.accountOwner.findMany({
        where,
        skip,
        take,
        orderBy: [{ bankbookNumber: 'asc' }, { accNumber: 'asc' }],
        include: {
          client: { select: { firstName: true, lastName: true, nickName: true } },
          account: {
            select: {
              accNameLao: true,
              accNameEng: true,
              currentBalance: true,
              statusId: true,
              accountType: { select: { nameLao: true, nameEng: true } },
            },
          },
        },
      }),
      this.prisma.accountOwner.count({ where }),
    ]);

    const results: AccountOwnerItem[] = rows.map((r) => ({
      bankbookNumber: r.bankbookNumber,
      accNumber: r.accNumber,
      vbCode: r.vbCode,
      clientId: r.clientId,
      clientName: this.fullName(r.client),
      accNameLao: r.account?.accNameLao ?? null,
      accNameEng: r.account?.accNameEng ?? null,
      currentBalance: r.account ? Number(r.account.currentBalance) : 0,
      accountType: r.account?.accountType?.nameLao ?? r.account?.accountType?.nameEng ?? null,
      statusId: r.account?.statusId ?? null,
    }));

    return createPrismaPaginatedResponse(
      results,
      total,
      page,
      limit,
      'Account owners fetched successfully',
    );
  }

  // ── 3b. Edit the savings (deposit) balance of an account ────────────────────
  // This is the WRITE path the offline app pushes to when it regains internet.
  async updateSavings(
    accNumber: string,
    dto: UpdateSavingsDto,
  ): Promise<{
    accNumber: string;
    vbCode: string;
    currentBalance: number;
    lastUpdate: Date;
  }> {
    const account = await this.prisma.accounts.findUnique({
      where: { accNumber },
      select: { accNumber: true, vbCode: true },
    });

    if (!account) {
      throw new NotFoundException(`Account ${accNumber} not found`);
    }

    // Ownership guard: if the client sent a vbCode, it must match.
    if (dto.vbCode && dto.vbCode.trim() !== account.vbCode.trim()) {
      throw new BadRequestException('vbCode does not match this account');
    }

    const updated = await this.prisma.accounts.update({
      where: { accNumber },
      data: {
        currentBalance: BigInt(dto.currentBalance),
        lastUpdate: new Date(),
      },
      select: { accNumber: true, vbCode: true, currentBalance: true, lastUpdate: true },
    });

    return {
      accNumber: updated.accNumber.trim(),
      vbCode: updated.vbCode.trim(),
      currentBalance: Number(updated.currentBalance),
      lastUpdate: updated.lastUpdate,
    };
  }

  // ── 3c. Withdraw from savings ─────────────────────────────────────────────────
  // Atomically:
  //   1. Decrease accounts.current_balance
  //   2. Create a 3101 withdrawal transaction (if tx code exists in this DB)
  //   3. Insert a client_equity_saving_arrangement row with withdrawalAmount filled
  async withdraw(
    accNumber: string,
    dto: WithdrawDto,
    performingUserId: string = 'qr-withdraw',
  ): Promise<{
    accNumber: string;
    vbCode: string;
    amount: number;
    currentBalance: number;
    transactionId: string;
    arrangementId: number | null;
    paymentMethod: string;
    date: Date;
  }> {
    // ── 1. Validate account ───────────────────────────────────────────────────
    const account = await this.prisma.accounts.findUnique({
      where: { accNumber },
      select: {
        accNumber: true,
        vbCode: true,
        bankbookNumber: true,
        currentBalance: true,
        statusId: true,
      },
    });

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account ${accNumber} not found`,
      });
    }
    if (dto.vbCode && dto.vbCode.trim() !== account.vbCode.trim()) {
      throw new BadRequestException({
        code: 'VB_MISMATCH',
        message: 'vbCode does not match this account',
      });
    }

    // Only ACTIVE accounts (status_id == '2') may be paid. Any other status
    // (loss '4', closed, etc.) is blocked.
    if (account.statusId?.trim() !== '2') {
      throw new BadRequestException({
        code: 'NOT_ACTIVE',
        message: 'Account is not active — payment not allowed.',
      });
    }

    // ── 1b. Check-in / check-out guards via vbc_arrangement ───────────────────
    const vbCode    = account.vbCode.trim();
    const bankbook  = account.bankbookNumber?.trim() ?? null;
    // Build exact date boundaries for today (UTC-midnight → UTC-midnight next day).
    // Using `lt: tomorrow` (exclusive) avoids any 23:59:59.999 millisecond edge-cases.
    const _now       = new Date();
    const todayDate  = utcDateOnly(_now);
    const tomorrowDate = new Date(todayDate.getTime() + 86_400_000);

    // Block if already checked out today.
    // Required: date == today AND points == 0 AND need_sync == 'u' AND last_update is set.
    const alreadyOut = await this.prisma.vbc_arrangement.findFirst({
      where: {
        vbcode:       vbCode,
        bankbooknumber: bankbook,
        date:         { gte: todayDate, lt: tomorrowDate },
        points:       0,
        need_sync:    'u',
        last_update:  { not: null },
      },
    });
    if (alreadyOut) {
      throw new BadRequestException({
        code: 'ALREADY_CHECKED_OUT',
        message: 'Already checked out today. Must check in again.',
      });
    }

    // Require a valid check-in today before allowing payment.
    // Required: date == today AND points == 1 AND need_sync == 'i'.
    const checkedInRow = await this.prisma.vbc_arrangement.findFirst({
      where: {
        vbcode:       vbCode,
        bankbooknumber: bankbook,
        date:         { gte: todayDate, lt: tomorrowDate },
        points:       1,
        need_sync:    'i',
      },
    });
    if (!checkedInRow) {
      throw new BadRequestException({
        code: 'MUST_CHECK_IN_FIRST',
        message: 'Must check in before withdrawing.',
      });
    }

    const amount = BigInt(dto.amount);
    if (account.currentBalance < amount) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_BALANCE',
        message: `Insufficient savings balance (have ${account.currentBalance}, need ${amount})`,
      });
    }

    // Block payment when this village bank has no cash on hand: the sum of the
    // cash-account family ('110' tree) for this vbCode must be > 0.
    const cashAgg = await this.prisma.$queryRaw<{ sum: bigint | null }[]>`
      SELECT COALESCE(SUM(current_balance), 0) AS sum
      FROM accounts
      WHERE vbcode = ${account.vbCode}
        AND TRIM(acc_code) IN ('110','1101','11011','110110','1101100')
    `;
    if ((cashAgg[0]?.sum ?? 0n) <= 0n) {
      throw new BadRequestException({
        code: 'NO_CASH',
        message: 'No cash available in this village bank.',
      });
    }

    // ── 2. Resolve optional dependencies ─────────────────────────────────────
    const txCodeRow = await this.prisma.transactionCode.findUnique({
      where: { transactionCode: SAVINGS_WITHDRAW_TX_CODE },
      select: {
        transactionCode: true,
        debitAccNumber: true,
        creditAccNumber: true,
      },
    });

    const txId = randomUUID();
    const newBalance = account.currentBalance - amount;
    const now = new Date();

    // Debit/credit account = this village's vbCode prefixed onto the account
    // configured on transaction_code 6607 (e.g. '1206023' + '73702000').
    const vbPrefix = account.vbCode.trim();
    const debitAcc =
      vbPrefix + (txCodeRow?.debitAccNumber?.trim() || '') || account.accNumber;
    const creditAcc =
      vbPrefix + (txCodeRow?.creditAccNumber?.trim() || '') || account.accNumber;

    // Default description by payment method (disbursement). An explicit note from
    // the caller still overrides this default.
    const paymentDescription =
      dto.paymentMethod === PaymentMethod.BankTransfer
        ? 'disbursement money for member by Bank Transfer'
        : 'disbursement money for member by Cash';

    // ── 3. Find clientId via account_owner (needed to update client record) ─────
    const ownerRow = await this.prisma.accountOwner.findFirst({
      where: { accNumber, vbCode: account.vbCode },
      select: { clientId: true },
    });

    // ── 4. Execute all writes atomically (interactive transaction) ────────────
    const arrangementId = await this.prisma.$transaction(async (tx) => {
      // Always: update the savings balance.
      await tx.accounts.update({
        where: { accNumber },
        data: { currentBalance: newBalance, lastUpdate: now },
      });

      // Decrease currentBalance on every acc_code target row in the same vbCode.
      // Uses raw SQL for an IN-clause on a padded CHAR column (trim needed).
      await tx.$executeRaw`
        UPDATE accounts
        SET  current_balance = current_balance - ${amount},
             last_update     = ${now}
        WHERE vbcode = ${account.vbCode}
          AND TRIM(acc_code) IN (
                '110','1101','11011','110110','1101100',
                '100','370','3702','37020','370200','3702000','300'
              )
      `;

      // If tx code 3101 exists: record a withdrawal transaction row.
      if (txCodeRow) {
        await tx.transactions.create({
          data: {
            id: txId,
            date: now,
            bankbookNumber: account.bankbookNumber,
            transactionCodeId: SAVINGS_WITHDRAW_TX_CODE,
            amount,
            debitAccNumber: debitAcc,
            creditAccNumber: creditAcc,
            vbCode: account.vbCode,
            description: dto.note?.trim() || paymentDescription,
            userId: performingUserId,   // ← actual logged-in system user ID
            paymentMethod: dto.paymentMethod,
            needSync: 'i',              // 'i' = inserted (needs sync upstream)
          },
        });
      }

      // Record this payment in cash_book_view (cash-book ledger). Composite PK is
      // (id, vbcode) with no auto-increment, so generate the next id per vbcode.
      const cashMax = await tx.cash_book_view.findFirst({
        where: { vbcode: account.vbCode },
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      await tx.cash_book_view.create({
        data: {
          id:             (cashMax?.id ?? 0) + 1,
          date:           now,                 // today
          acc_number:     account.accNumber,
          expenses:       amount,              // money paid out (checkout)
          balance:        newBalance,          // balance AFTER the withdrawal
          vbcode:         account.vbCode,
          need_sync:      'i',
          bankbooknumber: account.bankbookNumber,
          description:    dto.note?.trim() || paymentDescription,
        },
      });

      // If Bank Transfer: save recipient name + account number on the client record.
      // Must run BEFORE any early return so it always executes.
      if (
        dto.paymentMethod === PaymentMethod.BankTransfer &&
        ownerRow &&
        (dto.requestName?.trim() || dto.requestAccNumber?.trim())
      ) {
        await tx.client.update({
          where: { id: ownerRow.clientId },
          data: {
            requestName:      dto.requestName?.trim()      || null,
            requestAccNumber: dto.requestAccNumber?.trim() || null,
          },
        });
      }

      // Pay off the FULL overdue balance. Zero the current_balance of EVERY
      // arrangement row for this account+vbCode (the client sends the overdue
      // total as dto.amount, which equals the sum of these balances). Do NOT
      // touch withdrawal_amount on every row.
      let arrId: number | null = null;
      const latestArr = await tx.clientEquitySavingArrangement.findFirst({
        where: { accNumber: account.accNumber, vbCode: account.vbCode },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        select: { id: true, vbCode: true, withdrawalAmount: true },
      });
      await tx.$executeRaw`
        UPDATE client_equity_saving_arrangement
        SET current_balance = 0,
            need_sync        = 'u'
        WHERE TRIM(acc_number) = ${account.accNumber.trim()}
          AND TRIM(vbcode)     = ${account.vbCode.trim()}
      `;
      // Record the paid amount in withdrawal_amount on the LATEST-date row ONLY.
      if (latestArr) {
        await tx.clientEquitySavingArrangement.update({
          where: { id_vbCode: { id: latestArr.id, vbCode: latestArr.vbCode } },
          data: {
            withdrawalAmount: (latestArr.withdrawalAmount ?? 0n) + amount,
            needSync: 'u',
          },
        });
        arrId = Number(latestArr.id);
      }

      // Mark today's check-in record as checked-out: points=0, need_sync='u'.
      // Done INSIDE the transaction so if it fails the whole payment (balance,
      // cash decrement, transaction, cash-book, arrangement) rolls back.
      await tx.vbc_arrangement.update({
        where: { id_vbcode: { id: checkedInRow.id, vbcode: checkedInRow.vbcode } },
        data: { points: 0, need_sync: 'u', last_update: now },
      });

      // The full overdue total was disbursed, so mark EVERY remaining unpaid
      // check-in for this member (need_sync='i', any day) as checked-out too.
      await tx.vbc_arrangement.updateMany({
        where: { vbcode: vbCode, bankbooknumber: bankbook, need_sync: 'i' },
        data: { points: 0, need_sync: 'u', last_update: now },
      });

      return arrId;
    });

    return {
      accNumber: account.accNumber.trim(),
      vbCode: account.vbCode.trim(),
      amount: dto.amount,
      currentBalance: Number(newBalance),
      transactionId: txId,
      arrangementId,
      paymentMethod: dto.paymentMethod,
      date: now,
    };
  }

  // ── 3f. Check-in — insert into vbc_arrangement (points=1, need_sync='i') ────
  async checkIn(
    accNumber: string,
    dto: CheckInDto,
  ): Promise<{ accNumber: string; checkedIn: boolean; date: string; currentBalance: number }> {
    // 1. Resolve account → bankbookNumber + vbCode + statusId + balance.
    const account = await this.prisma.accounts.findUnique({
      where: { accNumber },
      select: {
        accNumber: true,
        vbCode: true,
        bankbookNumber: true,
        statusId: true,
        currentBalance: true,
      },
    });
    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account ${accNumber} not found`,
      });
    }
    if (dto.vbCode && dto.vbCode.trim() !== account.vbCode.trim()) {
      throw new ForbiddenException({
        code: 'VB_MISMATCH',
        message: 'vbCode does not match this account',
      });
    }

    const vbCode   = account.vbCode.trim();
    const bankbook = account.bankbookNumber?.trim() ?? null;
    // Exact date boundaries: UTC-midnight today → UTC-midnight tomorrow (exclusive).
    const _now         = new Date();
    const todayDate    = utcDateOnly(_now);
    const tomorrowDate = new Date(todayDate.getTime() + 86_400_000);

    // 2. Guard: already completed check-in AND check-out today.
    // Required: date == today AND points == 0 AND need_sync == 'u'.
    const completedToday = await this.prisma.vbc_arrangement.findFirst({
      where: {
        vbcode:       vbCode,
        bankbooknumber: bankbook,
        date:         { gte: todayDate, lt: tomorrowDate },
        points:       0,
        need_sync:    'u',
      },
    });
    if (completedToday) {
      throw new ConflictException({
        code: 'ALREADY_CHECKED_IN_OUT_TODAY',
        message: 'Already checked in and out today. Please check in next day.',
      });
    }

    // 3. Guard: already checked in today but not yet paid.
    // Required: date == today AND points == 1 AND need_sync == 'i'.
    const existing = await this.prisma.vbc_arrangement.findFirst({
      where: {
        vbcode:       vbCode,
        bankbooknumber: bankbook,
        date:         { gte: todayDate, lt: tomorrowDate },
        points:       1,
        need_sync:    'i',
      },
    });
    if (existing) {
      throw new ConflictException({
        code: 'ALREADY_CHECKED_IN',
        message: 'Already checked in today. Must check out (pay) first.',
      });
    }

    // 3. Look up vbc_id from VbCommitteeTeam (optional — not all members are committee members).
    const ownerRow = await this.prisma.accountOwner.findFirst({
      where: { accNumber: account.accNumber, vbCode: vbCode },
      select: { clientId: true },
    });
    let vbcId: string | null = null;
    if (ownerRow) {
      const teamRow = await this.prisma.vbCommitteeTeam.findFirst({
        where: { clientId: ownerRow.clientId, vbCode: vbCode },
        select: { vbcId: true },
      });
      vbcId = teamRow?.vbcId ?? null;
    }

    // 4. Generate next id (max id for this vbcode + 1).
    const maxRow = await this.prisma.vbc_arrangement.findFirst({
      where: { vbcode: vbCode },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const nextId = (maxRow?.id ?? 0) + 1;

    // 5. Atomically: insert the check-in row AND deposit the fixed amount into
    //    the member's savings balance. The amount comes from the client (fixed
    //    195,000) but falls back to the server default if omitted.
    const depositAmount = BigInt(dto.amount ?? CHECK_IN_DEPOSIT);
    const newBalance = account.currentBalance + depositAmount;

    await this.prisma.$transaction(async (tx) => {
      await tx.vbc_arrangement.create({
        data: {
          id:            nextId,
          date:          todayDate,
          bankbooknumber: bankbook,
          vbcode:        vbCode,
          points:        1,
          need_sync:     'i',
          vbc_id:        vbcId,
        },
      });

      if (depositAmount > 0n) {
        await tx.accounts.update({
          where: { accNumber },
          data: { currentBalance: { increment: depositAmount }, lastUpdate: new Date() },
        });
      }

      // Update the LATEST equity-saving arrangement for this account+vbCode
      // (the row with the largest date): add the deposit to currentBalance and
      // flag it for upstream sync.
      const latestArr = await tx.clientEquitySavingArrangement.findFirst({
        where: { accNumber: account.accNumber, vbCode: vbCode },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        select: { id: true, vbCode: true, currentBalance: true },
      });
      if (latestArr) {
        await tx.clientEquitySavingArrangement.update({
          where: { id_vbCode: { id: latestArr.id, vbCode: latestArr.vbCode } },
          data: {
            currentBalance: latestArr.currentBalance + depositAmount,
            needSync: 'u',
          },
        });
      }
    });

    return {
      accNumber: account.accNumber.trim(),
      checkedIn: true,
      date: todayDate.toISOString().split('T')[0],
      currentBalance: Number(newBalance),
    };
  }

  // ── 3e2. Find account owner by account number ────────────────────────────────
  // The QR only carries accNumber; this resolves vbCode + bankbookNumber from the DB.
  async findByAccNumber(
    accNumber: string,
    qrVersion?: number,
  ): Promise<AccountOwnerItem | null> {
    const trimmed = accNumber.trim();
    if (!trimmed) return null;

    // qr_version is MANDATORY. A scan without a valid version must not match —
    // the caller turns this null into the usual "account not found".
    if (qrVersion == null) {
      this.logger.warn(
        `[findByAccNumber] acc="${trimmed}" → REJECTED (no qr_version supplied)`,
      );
      return null;
    }

    // 1. Get vbCode + bankbookNumber from the accounts table — the account must
    //    match BOTH the account number AND the qr_version. An outdated/wrong QR
    //    returns null here (surfaced as "account not found").
    const account = await this.prisma.accounts.findFirst({
      where: { accNumber: trimmed, qrVersion },
      select: { accNumber: true, vbCode: true, bankbookNumber: true },
    });
    this.logger.log(
      `[findByAccNumber] acc="${trimmed}" qrVersion=${qrVersion} ` +
        `→ ${account ? 'MATCHED' : 'NOT FOUND'}`,
    );
    if (!account) return null;

    // 2. Find the matching account_owner row (carries the client relation).
    const owner = await this.prisma.accountOwner.findFirst({
      where: { accNumber: account.accNumber, vbCode: account.vbCode },
      include: {
        client: { select: { firstName: true, lastName: true, nickName: true } },
        account: {
          select: {
            accNameLao: true,
            accNameEng: true,
            currentBalance: true,
            statusId: true,
            accountType: { select: { nameLao: true, nameEng: true } },
          },
        },
      },
    });
    if (!owner) return null;

    const overdue = await this.overdueFor({
      accNumber: owner.accNumber,
      vbCode: owner.vbCode,
      bankbookNumber: owner.bankbookNumber,
    });

    return {
      bankbookNumber: owner.bankbookNumber,
      accNumber: owner.accNumber,
      vbCode: owner.vbCode,
      clientId: owner.clientId,
      clientName: this.fullName(owner.client),
      accNameLao: owner.account?.accNameLao ?? null,
      accNameEng: owner.account?.accNameEng ?? null,
      currentBalance: owner.account ? Number(owner.account.currentBalance) : 0,
      accountType:
        owner.account?.accountType?.nameLao ??
        owner.account?.accountType?.nameEng ??
        null,
      statusId: owner.account?.statusId ?? null,
      overduePayment: overdue.overduePayment,
      overdueCount: overdue.overdueCount,
    };
  }

  // ── 3e. Find account owner by ID-document number ────────────────────────────
  // Lookup chain: id_document.idDocumentNumber → clientId → account_owner → AccountOwnerItem
  async findByDocumentId(
    idNumber: string,
    vbCode?: string,
    fambookIndivNumber?: string,
    qrVersion?: number,
  ): Promise<AccountOwnerItem | null> {
    const trimmed = idNumber.trim();
    if (!trimmed) return null;
    const fambook = fambookIndivNumber?.trim();

    // qr_version is REQUIRED for the document lookup (same rule as the QR scan).
    // fambook_indiv_number stays optional.
    if (qrVersion == null) {
      this.logger.warn(
        `[findByDocumentId] idNumber="${trimmed}" → REJECTED (no qr_version supplied)`,
      );
      return null;
    }

    // 1. Search id_document by idDocumentNumber (mapped to "iddocmentnumber" column).
    //    Also filter by vbCode and (optionally) fambook_indiv_number when provided
    //    so the result is scoped more precisely.
    const doc = await this.prisma.idDocument.findFirst({
      where: {
        idDocumentNumber: trimmed,
        ...(vbCode?.trim() ? { vbCode: vbCode.trim() } : {}),
        ...(fambook ? { fambookIndivNumber: fambook } : {}),
      },
      select: { clientId: true, vbCode: true },
      orderBy: { id: 'desc' },
    });

    if (!doc) return null;

    // 2. Find the account_owner row for this client. When a qr_version is given,
    //    the linked account must match it too (optional extra filter).
    const effectiveVbCode = vbCode?.trim() || doc.vbCode?.trim();
    const owner = await this.prisma.accountOwner.findFirst({
      where: {
        clientId: doc.clientId,
        ...(effectiveVbCode ? { vbCode: effectiveVbCode } : {}),
        ...(qrVersion != null ? { account: { qrVersion } } : {}),
      },
      include: {
        client: { select: { firstName: true, lastName: true, nickName: true } },
        account: {
          select: {
            accNameLao: true,
            accNameEng: true,
            currentBalance: true,
            statusId: true,
            accountType: { select: { nameLao: true, nameEng: true } },
          },
        },
      },
      orderBy: { accNumber: 'asc' },
    });

    if (!owner) return null;

    const overdue = await this.overdueFor({
      accNumber: owner.accNumber,
      vbCode: owner.vbCode,
      bankbookNumber: owner.bankbookNumber,
    });

    return {
      bankbookNumber: owner.bankbookNumber,
      accNumber: owner.accNumber,
      vbCode: owner.vbCode,
      clientId: owner.clientId,
      clientName: this.fullName(owner.client),
      accNameLao: owner.account?.accNameLao ?? null,
      accNameEng: owner.account?.accNameEng ?? null,
      currentBalance: owner.account ? Number(owner.account.currentBalance) : 0,
      accountType:
        owner.account?.accountType?.nameLao ??
        owner.account?.accountType?.nameEng ??
        null,
      statusId: owner.account?.statusId ?? null,
      overduePayment: overdue.overduePayment,
      overdueCount: overdue.overdueCount,
    };
  }

  // ── 3d. List withdrawal transactions (only tx code 3101) for an account ─────
  async listWithdrawals(
    accNumber: string,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<any>> {
    const { skip, take, page, limit } = getPrismaPagination(pagination.page, pagination.limit);

    const account = await this.prisma.accounts.findUnique({
      where: { accNumber },
      select: { accNumber: true, vbCode: true, bankbookNumber: true },
    });
    if (!account) {
      throw new NotFoundException(`Account ${accNumber} not found`);
    }

    const where: any = {
      transactionCodeId: SAVINGS_WITHDRAW_TX_CODE,
      vbCode: account.vbCode,
      OR: [{ debitAccNumber: accNumber }, { creditAccNumber: accNumber }],
      NOT: { description: { startsWith: 'Reversed Trax By :' } },
    };
    if (account.bankbookNumber) where.bankbookNumber = account.bankbookNumber;

    const [rows, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take,
        orderBy: { date: pagination.sort || 'desc' },
        include: { transactionCode: { select: { nameLao: true, nameEng: true } } },
      }),
      this.prisma.transactions.count({ where }),
    ]);

    const results = rows.map((t) => ({
      id: t.id,
      accNumber: accNumber.trim(),
      vbCode: t.vbCode.trim(),
      bankbookNumber: t.bankbookNumber?.trim() ?? null,
      amount: Number(t.amount),
      date: t.date,
      description: t.description,
      txCode: t.transactionCodeId.trim(),
      txName: t.transactionCode?.nameLao ?? t.transactionCode?.nameEng ?? null,
      paymentMethod: t.paymentMethod ?? null,
    }));

    return createPrismaPaginatedResponse(results, total, page, limit, 'Withdrawals fetched successfully');
  }

  // ── 4z. Today's check-ins only — lightweight, fast reconcile ────────────────
  // The full /sync snapshot bundles every transaction (large, grows over time)
  // so on a brief connection its download can time out before the app reconciles
  // the check-in rows. This tiny endpoint returns ONLY today's vbc_arrangement
  // rows so the app can refresh check-in/out state in well under a second — even
  // when the heavy snapshot can't finish. (The snapshot still returns check-ins
  // too; this is just a fast, reliable path.)
  async getCheckinsToday(): Promise<{
    serverTime: string;
    checkins: CheckinSyncItem[];
  }> {
    const serverTime = new Date().toISOString();
    const todayStart    = utcDateOnly();
    const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);

    const checkinRows = await this.prisma.vbc_arrangement.findMany({
      where: { date: { gte: todayStart, lt: tomorrowStart } },
    });

    return {
      serverTime,
      checkins: checkinRows.map((r) => ({
        bankbookNumber: r.bankbooknumber?.trim() ?? null,
        vbCode: r.vbcode.trim(),
        date: r.date ? ymd(r.date) : ymd(todayStart),
        points: r.points,
        needSync: r.need_sync?.trim() ?? null,
        lastUpdate: r.last_update ? r.last_update.toISOString() : null,
      })),
    };
  }

  // ── 4. Sync snapshot — full dataset for offline SQLite caching ──────────────
  // The Flutter app pulls this when online and mirrors it into SQLite so that
  // login / search / detail keep working with no internet. `since` (ISO date)
  // lets the app pull only rows changed after its last successful sync.
  async getSyncSnapshot(since?: string): Promise<{
    serverTime: string;
    sinceApplied: string | null;
    vbCodes: VbCodeListItem[];
    accountOwners: AccountOwnerItem[];
    checkins: CheckinSyncItem[];
    idDocuments: IdDocumentSyncItem[];
    transactions: TransactionSyncItem[];
    // Delete-aware reconciliation: the FULL set of current primary keys for the
    // incrementally-synced master tables, so the client can prune local rows the
    // server no longer has. Transactions are append-only (no prune list needed);
    // vbCodes are returned in full so the client prunes against `vbCodes` itself.
    accountOwnerKeys: string[];   // 'bankbook|accNumber|clientId'
    idDocumentIds: string[];      // id_document primary keys (BigInt as string)
    // Account configured on transaction_code 6607 — the offline client prefixes
    // the vbCode onto these to build debit/credit numbers for pending rows.
    withdrawDebitBase: string;
    withdrawCreditBase: string;
  }> {
    const serverTime = new Date().toISOString();
    const sinceDate = since ? new Date(since) : null;
    const validSince = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : null;

    // For incremental sync we use the `synchronized` timestamp present on these
    // tables. Rows with a NULL `synchronized` are always included (never synced).
    const incWhere = validSince
      ? { OR: [{ synchronized: { gte: validSince } }, { synchronized: null }] }
      : {};

    // Today's date boundaries (server-local) for the check-in rows. The app only
    // needs TODAY's vbc_arrangement rows — check-in status resets each day.
    const _now = new Date();
    const todayStart = utcDateOnly(_now);
    const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);

    const [
      vbRows,
      ownerRows,
      checkinRows,
      idDocRows,
      txRows,
      ownerKeyRows,
      idDocKeyRows,
      withdrawTxCode,
      cashRows,
      overdueSumRows,
      overdueCntRows,
    ] = await Promise.all([
      this.prisma.vbCode.findMany({
        // Only ACTIVE village banks (villagebank.status_id == '2') — matches the
        // list endpoint and keeps the offline mirror small (17 vs 9235 rows).
        where: { villageBank: { statusId: '2' } },
        orderBy: { id: 'asc' },
        include: {
          province: { select: { nameLao: true, nameEng: true } },
          district: { select: { nameLao: true, nameEng: true } },
          villageBank: { select: { nameLao: true, foundingDate: true, statusId: true } },
          _count: { select: { clients: true, accountOwners: true } },
        },
      }),
      this.prisma.accountOwner.findMany({
        where: incWhere,
        orderBy: [{ vbCode: 'asc' }, { bankbookNumber: 'asc' }, { accNumber: 'asc' }],
        include: {
          client: { select: { firstName: true, lastName: true, nickName: true } },
          account: {
            select: {
              accNameLao: true,
              accNameEng: true,
              currentBalance: true,
              statusId: true,
              accountType: { select: { nameLao: true, nameEng: true } },
            },
          },
        },
      }),
      // Today's check-in / check-out rows from vbc_arrangement.
      this.prisma.vbc_arrangement.findMany({
        where: { date: { gte: todayStart, lt: tomorrowStart } },
      }),
      // id_document rows (incremental) — enables offline lookup by document number.
      this.prisma.idDocument.findMany({
        where: { ...incWhere, idDocumentNumber: { not: null } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          idDocumentNumber: true,
          clientId: true,
          vbCode: true,
          documentNameLao: true,
          documentNameEng: true,
        },
      }),
      // Payment transactions (tx 3101) — incremental, append-only history.
      this.prisma.transactions.findMany({
        where: { ...incWhere, transactionCodeId: SAVINGS_WITHDRAW_TX_CODE },
        orderBy: { date: 'desc' },
        include: {
          transactionCode: { select: { nameLao: true, nameEng: true } },
          debitAccount: { select: { accNameLao: true } },
        },
      }),
      // Delete-aware: full key set for account_owner (lightweight projection).
      this.prisma.accountOwner.findMany({
        select: { bankbookNumber: true, accNumber: true, clientId: true },
      }),
      // Delete-aware: full id set for id_document.
      this.prisma.idDocument.findMany({
        where: { idDocumentNumber: { not: null } },
        select: { id: true },
      }),
      // The debit/credit account base configured on the withdrawal tx code (6607).
      this.prisma.transactionCode.findUnique({
        where: { transactionCode: SAVINGS_WITHDRAW_TX_CODE },
        select: { debitAccNumber: true, creditAccNumber: true },
      }),
      // Per-vbCode cash-on-hand: sum of the '110' account family. Lets the offline
      // client enforce the no-cash guard without mirroring every internal account.
      this.prisma.$queryRaw<{ vbcode: string; sum: bigint | null }[]>`
        SELECT vbcode, COALESCE(SUM(current_balance), 0) AS sum
        FROM accounts
        WHERE TRIM(acc_code) IN ('110','1101','11011','110110','1101100')
        GROUP BY vbcode
      `,
      // Per-account overdue total: SUM(current_balance) of the equity-saving
      // arrangement, so the offline client can show the checkout "overdue" card.
      this.prisma.$queryRaw<{ acc_number: string; vbcode: string; sum: bigint | null }[]>`
        SELECT acc_number, vbcode, COALESCE(SUM(current_balance), 0) AS sum
        FROM client_equity_saving_arrangement
        GROUP BY acc_number, vbcode
      `,
      // Per-member count of unpaid check-ins (vbc_arrangement need_sync = 'i').
      this.prisma.$queryRaw<{ bankbooknumber: string | null; vbcode: string; cnt: bigint }[]>`
        SELECT bankbooknumber, vbcode, COUNT(*) AS cnt
        FROM vbc_arrangement
        WHERE need_sync = 'i'
        GROUP BY bankbooknumber, vbcode
      `,
    ]);

    // Map vbCode → cash-on-hand sum for quick lookup when building vbCode items.
    const cashByVb = new Map<string, number>(
      cashRows.map((r) => [r.vbcode.trim(), Number(r.sum ?? 0n)]),
    );

    // Per-account overdue total ('accNumber|vbCode' → sum) and per-member unpaid
    // check-in count ('bankbook|vbCode' → count), attached to each account owner.
    const overdueByAcc = new Map<string, number>(
      overdueSumRows.map((r) => [
        `${r.acc_number.trim()}|${r.vbcode.trim()}`,
        Number(r.sum ?? 0n),
      ]),
    );
    const overdueCntByMember = new Map<string, number>(
      overdueCntRows.map((r) => [
        `${(r.bankbooknumber ?? '').trim()}|${r.vbcode.trim()}`,
        Number(r.cnt),
      ]),
    );

    return {
      serverTime,
      sinceApplied: validSince ? validSince.toISOString() : null,
      accountOwnerKeys: ownerKeyRows.map(
        (r) => `${r.bankbookNumber}|${r.accNumber}|${r.clientId}`,
      ),
      idDocumentIds: idDocKeyRows.map((r) => r.id.toString()),
      checkins: checkinRows.map((r) => ({
        bankbookNumber: r.bankbooknumber?.trim() ?? null,
        vbCode: r.vbcode.trim(),
        date: r.date ? ymd(r.date) : ymd(todayStart),
        points: r.points,
        needSync: r.need_sync?.trim() ?? null,
        lastUpdate: r.last_update ? r.last_update.toISOString() : null,
      })),
      idDocuments: idDocRows.map((r) => ({
        id: r.id.toString(),
        idDocumentNumber: r.idDocumentNumber!.trim(),
        clientId: r.clientId,
        vbCode: r.vbCode?.trim() ?? null,
        documentNameLao: r.documentNameLao ?? null,
        documentNameEng: r.documentNameEng ?? null,
      })),
      transactions: txRows.map((r) => ({
        id: r.id,
        date: r.date.toISOString(),
        bankbookNumber: r.bankbookNumber?.trim() ?? null,
        transactionCodeId: r.transactionCodeId.trim(),
        txNameLao: r.transactionCode?.nameLao ?? null,
        txNameEng: r.transactionCode?.nameEng ?? null,
        amount: Number(r.amount),
        debitAccNumber: r.debitAccNumber.trim(),
        debitAccNameLao: r.debitAccount?.accNameLao ?? null,
        creditAccNumber: r.creditAccNumber.trim(),
        description: r.description ?? null,
        paymentMethod: r.paymentMethod ?? null,
        vbCode: r.vbCode.trim(),
      })),
      vbCodes: vbRows.map((r) => ({
        vbCode: r.id,
        nameLao: r.nameLao,
        nameEng: r.nameEng,
        provinceId: r.provinceId,
        provinceName: r.province?.nameLao ?? r.province?.nameEng ?? null,
        districtId: r.districtId,
        districtName: r.district?.nameLao ?? r.district?.nameEng ?? null,
        villageBankName: r.villageBank?.nameLao ?? null,
        foundingDate: r.villageBank?.foundingDate ?? null,
        statusId: r.villageBank?.statusId ?? null,
        clientCount: r._count.clients,
        accountOwnerCount: r._count.accountOwners,
        cashBalance: cashByVb.get(r.id.trim()) ?? 0,
      })),
      accountOwners: ownerRows.map((r) => ({
        bankbookNumber: r.bankbookNumber,
        accNumber: r.accNumber,
        vbCode: r.vbCode,
        clientId: r.clientId,
        clientName: this.fullName(r.client),
        accNameLao: r.account?.accNameLao ?? null,
        accNameEng: r.account?.accNameEng ?? null,
        currentBalance: r.account ? Number(r.account.currentBalance) : 0,
        accountType: r.account?.accountType?.nameLao ?? r.account?.accountType?.nameEng ?? null,
        statusId: r.account?.statusId ?? null,
        overduePayment:
          overdueByAcc.get(`${r.accNumber.trim()}|${r.vbCode.trim()}`) ?? 0,
        overdueCount:
          overdueCntByMember.get(
            `${(r.bankbookNumber ?? '').trim()}|${r.vbCode.trim()}`,
          ) ?? 0,
      })),
      withdrawDebitBase: withdrawTxCode?.debitAccNumber?.trim() ?? '',
      withdrawCreditBase: withdrawTxCode?.creditAccNumber?.trim() ?? '',
    };
  }
}
