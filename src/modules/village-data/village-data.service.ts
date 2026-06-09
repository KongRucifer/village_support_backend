import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

// Savings withdrawal transaction code (see TransactionsService.SAVINGS_TX_CODES).
const SAVINGS_WITHDRAW_TX_CODE = '3101';

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

/** Format a Date as 'YYYY-MM-DD' using local components (matches the device). */
function ymd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

@Injectable()
export class VillageDataService {
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

  // ── 1. VbCode list — paginated + search by code / name ──────────────────────
  async listVbCodes(query: VbCodeQueryDto): Promise<PaginatedResult<VbCodeListItem>> {
    const { skip, take, page, limit } = getPrismaPagination(query.page, query.limit);
    const search = query.search?.trim();

    const where = search
      ? {
          OR: [
            { id: { contains: search, mode: 'insensitive' as const } },
            { nameLao: { contains: search, mode: 'insensitive' as const } },
            { nameEng: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

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

    // Block payment for accounts on loss status (status_id = '4').
    if (account.statusId?.trim() === '4') {
      throw new BadRequestException({
        code: 'LOSS_STATUS',
        message: 'Account is inactive (loss status) — payment not allowed.',
      });
    }

    // ── 1b. Check-in / check-out guards via vbc_arrangement ───────────────────
    const vbCode    = account.vbCode.trim();
    const bankbook  = account.bankbookNumber?.trim() ?? null;
    // Build exact date boundaries for today (midnight → midnight next day).
    // Using `lt: tomorrow` (exclusive) avoids any 23:59:59.999 millisecond edge-cases.
    const _now       = new Date();
    const todayDate  = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
    const tomorrowDate = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() + 1);

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

    // ── 2. Resolve optional dependencies ─────────────────────────────────────
    const [txCodeRow, existingArrangement] = await Promise.all([
      this.prisma.transactionCode.findUnique({
        where: { transactionCode: SAVINGS_WITHDRAW_TX_CODE },
        select: { transactionCode: true },
      }),
      // Find the most-recent equity saving arrangement for this account so we
      // can copy clientEquitySavingConditionId and statusId (both required).
      // Fall back to any arrangement on the same vbCode if the account has none.
      this.prisma.clientEquitySavingArrangement.findFirst({
        where: { accNumber },
        select: { clientEquitySavingConditionId: true, statusId: true },
        orderBy: { id: 'desc' },
      }).then(async (row) => {
        if (row) return row;
        return this.prisma.clientEquitySavingArrangement.findFirst({
          where: { vbCode: account.vbCode },
          select: { clientEquitySavingConditionId: true, statusId: true },
          orderBy: { id: 'desc' },
        });
      }),
    ]);

    const txId = randomUUID();
    const newBalance = account.currentBalance - amount;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const conditionId = existingArrangement?.clientEquitySavingConditionId ?? null;
    const arrangementStatusId = existingArrangement?.statusId ?? account.statusId;

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
            debitAccNumber: account.accNumber,
            creditAccNumber: account.accNumber,
            vbCode: account.vbCode,
            description: dto.note?.trim() || 'Savings payment',
            userId: performingUserId,   // ← actual logged-in system user ID
            paymentMethod: dto.paymentMethod,
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
          description:    dto.note?.trim() || 'Savings payment',
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

      // If a clientEquitySavingConditionId exists: insert the arrangement row.
      if (conditionId !== null) {
        const arr = await tx.clientEquitySavingArrangement.create({
          data: {
            date: today,
            accNumber: account.accNumber,
            vbCode: account.vbCode,
            currentBalance: newBalance,
            savingAmount: BigInt(0),
            withdrawalAmount: amount,
            interestNumerator: BigInt(0),
            clientEquitySavingConditionId: conditionId,
            statusId: arrangementStatusId,
            needSync: 'Y',
          },
          select: { id: true },
        });
        return Number(arr.id);
      }

      return null;
    });

    // Mark check-in record as checked-out: points=0, need_sync='u', last_update=now.
    await this.prisma.vbc_arrangement.update({
      where: { id_vbcode: { id: checkedInRow.id, vbcode: checkedInRow.vbcode } },
      data: { points: 0, need_sync: 'u', last_update: now },
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
  ): Promise<{ accNumber: string; checkedIn: boolean; date: string }> {
    // 1. Resolve account → bankbookNumber + vbCode + statusId.
    const account = await this.prisma.accounts.findUnique({
      where: { accNumber },
      select: { accNumber: true, vbCode: true, bankbookNumber: true, statusId: true },
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

    // Guard: account is on loss status (status_id = '4') — no check-in/out allowed.
    if (account.statusId?.trim() === '4') {
      throw new BadRequestException({
        code: 'LOSS_STATUS',
        message: 'Account is inactive (loss status) — check-in not allowed.',
      });
    }

    const vbCode   = account.vbCode.trim();
    const bankbook = account.bankbookNumber?.trim() ?? null;
    // Exact date boundaries: midnight today → midnight tomorrow (exclusive upper bound).
    const _now         = new Date();
    const todayDate    = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
    const tomorrowDate = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() + 1);

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

    // 5. Insert the check-in row using the same todayDate used in the guards above.
    await this.prisma.vbc_arrangement.create({
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

    return {
      accNumber: account.accNumber.trim(),
      checkedIn: true,
      date: todayDate.toISOString().split('T')[0],
    };
  }

  // ── 3e2. Find account owner by account number ────────────────────────────────
  // The QR only carries accNumber; this resolves vbCode + bankbookNumber from the DB.
  async findByAccNumber(accNumber: string): Promise<AccountOwnerItem | null> {
    const trimmed = accNumber.trim();
    if (!trimmed) return null;

    // 1. Get vbCode + bankbookNumber from the accounts table.
    const account = await this.prisma.accounts.findUnique({
      where: { accNumber: trimmed },
      select: { accNumber: true, vbCode: true, bankbookNumber: true },
    });
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
    };
  }

  // ── 3e. Find account owner by ID-document number ────────────────────────────
  // Lookup chain: id_document.idDocumentNumber → clientId → account_owner → AccountOwnerItem
  async findByDocumentId(
    idNumber: string,
    vbCode?: string,
  ): Promise<AccountOwnerItem | null> {
    const trimmed = idNumber.trim();
    if (!trimmed) return null;

    // 1. Search id_document by idDocumentNumber (mapped to "iddocmentnumber" column).
    //    Also filter by vbCode when provided so the result is scoped to this village.
    const doc = await this.prisma.idDocument.findFirst({
      where: {
        idDocumentNumber: trimmed,
        ...(vbCode?.trim() ? { vbCode: vbCode.trim() } : {}),
      },
      select: { clientId: true, vbCode: true },
      orderBy: { id: 'desc' },
    });

    if (!doc) return null;

    // 2. Find the account_owner row for this client.
    const effectiveVbCode = vbCode?.trim() || doc.vbCode?.trim();
    const owner = await this.prisma.accountOwner.findFirst({
      where: {
        clientId: doc.clientId,
        ...(effectiveVbCode ? { vbCode: effectiveVbCode } : {}),
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
    const _now = new Date();
    const todayStart    = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
    const tomorrowStart = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() + 1);

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
    const todayStart = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
    const tomorrowStart = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() + 1);

    const [
      vbRows,
      ownerRows,
      checkinRows,
      idDocRows,
      txRows,
      ownerKeyRows,
      idDocKeyRows,
    ] = await Promise.all([
      this.prisma.vbCode.findMany({
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
    ]);

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
      })),
    };
  }
}
