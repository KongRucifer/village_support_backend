import { Body, Controller, Get, Logger, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { VillageDataService } from './village-data.service.js';
import { VbCodeQueryDto, AccountOwnerQueryDto } from './dto/vbcode-query.dto.js';
import { UpdateSavingsDto } from './dto/update-savings.dto.js';
import { WithdrawDto } from './dto/withdraw.dto.js';
import { CheckInDto } from './dto/checkin.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';

@ApiTags('Village Data (offline app)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('village-data')
export class VillageDataController {
  private readonly logger = new Logger(VillageDataController.name);

  constructor(private readonly villageDataService: VillageDataService) {}

  @Get('vbcodes')
  @ApiOperation({ summary: 'List village banks (vbcode) — paginated, searchable by code or name' })
  @ApiResponse({ status: 200, description: 'VbCodes fetched successfully' })
  listVbCodes(@Query() query: VbCodeQueryDto) {
    return this.villageDataService.listVbCodes(query);
  }

  @Get('vbcodes/:vbCode')
  @ApiOperation({ summary: 'Get a single village bank (vbcode) detail' })
  @ApiParam({ name: 'vbCode', description: 'Village bank code', example: '0101001' })
  @ApiResponse({ status: 200, description: 'VbCode detail' })
  @ApiResponse({ status: 404, description: 'VbCode not found' })
  getVbCode(@Param('vbCode') vbCode: string) {
    return this.villageDataService.getVbCode(vbCode);
  }

  @Get('account-owners')
  @ApiOperation({
    summary: 'List account owners — filter by vbCode (+ optional bankbookNumber). Shows client name, not id.',
  })
  @ApiResponse({ status: 200, description: 'Account owners fetched successfully' })
  listAccountOwners(@Query() query: AccountOwnerQueryDto) {
    return this.villageDataService.listAccountOwners(query);
  }

  @Patch('accounts/:accNumber/savings')
  @ApiOperation({
    summary: 'Edit the savings (deposit) balance of an account',
    description:
      'Write path used by the offline app: the app queues edits locally while offline and ' +
      'pushes them here once it is back online.',
  })
  @ApiParam({ name: 'accNumber', description: 'Account number', example: '010100100000001' })
  @ApiResponse({ status: 200, description: 'Savings balance updated' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  updateSavings(@Param('accNumber') accNumber: string, @Body() dto: UpdateSavingsDto) {
    return this.villageDataService.updateSavings(accNumber, dto);
  }

  @Post('accounts/:accNumber/withdraw')
  @ApiOperation({
    summary: 'Pay from savings — decreases the balance, updates acc_code parent rows, and records a 3101 transaction with the performer\'s user ID',
  })
  @ApiParam({ name: 'accNumber', description: 'Account number', example: '010100100000001' })
  @ApiResponse({ status: 201, description: 'Payment recorded' })
  @ApiResponse({ status: 400, description: 'Insufficient balance / vbCode mismatch' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  withdraw(@Req() req: Request, @Param('accNumber') accNumber: string, @Body() dto: WithdrawDto) {
    // System-user tokens put the JWT sub on `id` ('sys:<numericId>'); client
    // tokens use `bankbookNumber`. Prefer id, then bankbookNumber.
    const u = req.user as any;
    const sub: string = u?.id ?? u?.bankbookNumber ?? 'unknown';
    // Strip the 'sys:' prefix so the DB stores just the numeric ID (e.g. '2', '27').
    const performingUserId = sub.startsWith('sys:') ? sub.slice(4) : sub;
    return this.villageDataService.withdraw(accNumber, dto, performingUserId);
  }

  @Post('accounts/:accNumber/checkin')
  @ApiOperation({
    summary: 'Check in — sets status_scan = 1. Rejected if already checked in (status_scan = 1).',
  })
  @ApiParam({ name: 'accNumber', description: 'Account number', example: '010100100000001' })
  @ApiResponse({ status: 201, description: 'Checked in successfully' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  @ApiResponse({ status: 409, description: 'Already checked in' })
  checkIn(@Param('accNumber') accNumber: string, @Body() dto: CheckInDto) {
    return this.villageDataService.checkIn(accNumber, dto);
  }

  @Get('accounts/:accNumber/overdue')
  @ApiOperation({
    summary: 'Overdue payment summary — total accumulated unpaid equity-saving balance and the number of unpaid check-ins',
  })
  @ApiParam({ name: 'accNumber', description: 'Account number', example: '010100100000001' })
  @ApiQuery({ name: 'vbCode', required: false, description: 'Optional vbCode ownership guard' })
  @ApiResponse({ status: 200, description: 'Overdue summary' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  getOverdue(@Param('accNumber') accNumber: string, @Query('vbCode') vbCode?: string) {
    return this.villageDataService.getOverdue(accNumber, vbCode);
  }

  @Get('accounts/:accNumber/withdrawals')
  @ApiOperation({ summary: 'List withdrawal transactions (only tx code 3101) for an account' })
  @ApiParam({ name: 'accNumber', description: 'Account number', example: '010100100000001' })
  @ApiResponse({ status: 200, description: 'Withdrawals fetched successfully' })
  listWithdrawals(@Param('accNumber') accNumber: string, @Query() pagination: PaginationDto) {
    return this.villageDataService.listWithdrawals(accNumber, pagination);
  }

  @Get('find-by-account')
  @ApiOperation({
    summary: 'Find account owner by account number — resolves bankbookNumber + vbCode automatically',
    description: 'The QR code only needs to carry the accNumber. The backend looks up vbCode and bankbookNumber from the accounts table.',
  })
  @ApiQuery({ name: 'accNumber', required: true, description: 'Account number (15 chars)' })
  @ApiQuery({ name: 'qrVersion', required: false, description: 'QR version (digits after the 15-char account number). When provided, the account must match this version too.' })
  @ApiResponse({ status: 200, description: 'Account owner found' })
  @ApiResponse({ status: 404, description: 'Account or owner not found' })
  async findByAccNumber(
    @Query('accNumber') accNumber: string,
    @Query('qrVersion') qrVersion?: string,
  ) {
    const parsed = qrVersion != null && qrVersion.trim() !== '' ? Number(qrVersion) : undefined;
    const ver = parsed != null && !Number.isNaN(parsed) ? parsed : undefined;
    // Log so we can confirm the scanned QR actually carried a qr_version.
    this.logger.log(
      `[find-by-account] accNumber="${accNumber}" qrVersionRaw="${qrVersion ?? ''}" ` +
        `→ qrVersion=${ver ?? '(NOT SENT)'}`,
    );
    const result = await this.villageDataService.findByAccNumber(accNumber, ver);
    if (!result) {
      throw new (await import('@nestjs/common').then(m => m.NotFoundException))(
        `No account owner found for account "${accNumber}"`,
      );
    }
    return result;
  }

  @Get('find-by-document')
  @ApiOperation({
    summary: 'Find account owner by ID document number',
    description:
      'Lookup chain: id_document.idDocumentNumber → clientId → account_owner. ' +
      'Returns the matched AccountOwner (same shape as /account-owners). ' +
      'Pass vbCode to scope the search to a specific village.',
  })
  @ApiQuery({ name: 'idNumber', required: true, description: 'ID document number (iddocmentnumber column)' })
  @ApiQuery({ name: 'vbCode', required: false, description: 'Optional village-bank code to narrow the search' })
  @ApiQuery({ name: 'fambookIndivNumber', required: false, description: 'Optional family-book individual number filter (id_document.fambook_indiv_number)' })
  @ApiQuery({ name: 'qrVersion', required: false, description: 'Optional qr_version filter — the matched account must have this version' })
  @ApiResponse({ status: 200, description: 'Account owner found' })
  @ApiResponse({ status: 404, description: 'No document / no account owner found' })
  async findByDocumentId(
    @Query('idNumber') idNumber: string,
    @Query('vbCode') vbCode?: string,
    @Query('fambookIndivNumber') fambookIndivNumber?: string,
    @Query('qrVersion') qrVersion?: string,
  ) {
    const parsed = qrVersion != null && qrVersion.trim() !== '' ? Number(qrVersion) : undefined;
    const ver = parsed != null && !Number.isNaN(parsed) ? parsed : undefined;
    const result = await this.villageDataService.findByDocumentId(
      idNumber,
      vbCode,
      fambookIndivNumber,
      ver,
    );
    if (!result) {
      throw new (await import('@nestjs/common').then(m => m.NotFoundException))(
        `No account owner found for document "${idNumber}"`,
      );
    }
    return result;
  }

  @Get('sync')
  @ApiOperation({
    summary: 'Sync snapshot — full dataset (vbcodes + account owners) for offline SQLite caching',
    description:
      'Pull this when the device is online to mirror data into SQLite. Pass `since` (ISO timestamp ' +
      'from a previous sync) to fetch only rows changed after that time.',
  })
  @ApiQuery({ name: 'since', required: false, description: 'ISO timestamp of the last successful sync' })
  @ApiResponse({ status: 200, description: 'Sync snapshot' })
  getSync(@Query('since') since?: string) {
    return this.villageDataService.getSyncSnapshot(since);
  }

  @Get('sync/checkins')
  @ApiOperation({
    summary: "Today's check-in rows only (lightweight) — fast reconcile of vbc_arrangement",
    description:
      'Returns only today\'s check-in / check-out rows so the offline app can refresh ' +
      'check-in state in well under a second, even when the full /sync snapshot is too ' +
      'large to download on a brief connection.',
  })
  @ApiResponse({ status: 200, description: "Today's check-ins" })
  getSyncCheckins() {
    return this.villageDataService.getCheckinsToday();
  }
}
