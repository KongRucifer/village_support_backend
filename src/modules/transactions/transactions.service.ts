import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PaginationDto, PaginatedResult, createPaginatedResponse, calculatePagination } from '../../common/dto/pagination.dto.js';
import { getPrismaPagination } from '../../common/utils/prisma-pagination.util.js';

const LOAN_TX_CODES = ['1201', '1010', '1001'];
const SAVINGS_TX_CODES = ['1006', '3101', '6410', '6607'];
const LOAN_ACC_TYPE_ID = '5';
const SAVINGS_ACC_TYPE_ID = '9';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findByAccount(accountId: string, paginationDto: PaginationDto, txCode?: string): Promise<PaginatedResult<any>> {
    const { skip, take, page, limit } = getPrismaPagination(paginationDto.page, paginationDto.limit);

    const account = await this.prisma.accounts.findUnique({
      where: { accNumber: accountId },
      select: { bankbookNumber: true, vbCode: true, accTypeId: true },
    });

    if (!account || !account.bankbookNumber) {
      const pagination = calculatePagination(0, page, limit);
      return createPaginatedResponse([], pagination, 'Account transactions fetched successfully');
    }

    const allowedTxCodes = account.accTypeId === LOAN_ACC_TYPE_ID
      ? LOAN_TX_CODES
      : account.accTypeId === SAVINGS_ACC_TYPE_ID
        ? SAVINGS_TX_CODES
        : [...LOAN_TX_CODES, ...SAVINGS_TX_CODES];

    const reversedPrefix = 'Reversed Trax By :';

    const accNumberConditions = account.accTypeId === LOAN_ACC_TYPE_ID
      ? [{ creditAccNumber: accountId }, { debitAccNumber: accountId }, { description: accountId }]
      : [{ creditAccNumber: accountId }, { debitAccNumber: accountId }];

    const where: any = {
      bankbookNumber: account.bankbookNumber,
      vbCode: account.vbCode,
      OR: accNumberConditions,
      transactionCodeId: txCode ? txCode : { in: allowedTxCodes },
      NOT: { description: { startsWith: reversedPrefix } },
    };

    const [transactions, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take,
        include: {
          debitAccount: { select: { accNumber: true, accNameLao: true } },
          transactionCode: true,
        },
        orderBy: { date: paginationDto.sort || 'desc' },
      }),
      this.prisma.transactions.count({ where }),
    ]);

    const pagination = calculatePagination(total, page, limit);
    return createPaginatedResponse(transactions, pagination, 'Account transactions fetched successfully');
  }

  async findByAccountAndYear(
    accountId: string,
    year: number,
    paginationDto: PaginationDto,
    txCode?: string,
  ): Promise<PaginatedResult<any>> {
    const { skip, take, page, limit } = getPrismaPagination(paginationDto.page, paginationDto.limit);

    const account = await this.prisma.accounts.findUnique({
      where: { accNumber: accountId },
      select: { bankbookNumber: true, vbCode: true, accTypeId: true },
    });

    if (!account || !account.bankbookNumber) {
      const pagination = calculatePagination(0, page, limit);
      return createPaginatedResponse([], pagination, 'Account year transactions fetched successfully');
    }

    const allowedTxCodes = account.accTypeId === LOAN_ACC_TYPE_ID
      ? LOAN_TX_CODES
      : account.accTypeId === SAVINGS_ACC_TYPE_ID
        ? SAVINGS_TX_CODES
        : [...LOAN_TX_CODES, ...SAVINGS_TX_CODES];

    const startDate = new Date(`${year}-01-01`);
    const endDate = new Date(`${year + 1}-01-01`);
    const reversedPrefix = 'Reversed Trax By :';

    const accNumberConditions = account.accTypeId === LOAN_ACC_TYPE_ID
      ? [{ creditAccNumber: accountId }, { debitAccNumber: accountId }, { description: accountId }]
      : [{ creditAccNumber: accountId }, { debitAccNumber: accountId }];

    const where: any = {
      bankbookNumber: account.bankbookNumber,
      vbCode: account.vbCode,
      date: { gte: startDate, lt: endDate },
      OR: accNumberConditions,
      transactionCodeId: txCode ? txCode : { in: allowedTxCodes },
      NOT: { description: { startsWith: reversedPrefix } },
    };

    const [transactions, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take,
        include: {
          debitAccount: {
            select: {
              accNumber: true,
              accNameLao: true,
              vb: { select: { nameEng: true, nameLao: true } },
            },
          },
          transactionCode: true,
        },
        orderBy: { date: paginationDto.sort || 'desc' },
      }),
      this.prisma.transactions.count({ where }),
    ]);

    const pagination = calculatePagination(total, page, limit);
    return createPaginatedResponse(transactions, pagination, 'Account year transactions fetched successfully');
  }
}
