import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';

@ApiTags('8. Transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get('account/:accountId')
  @ApiOperation({ summary: 'Get all transactions for a specific account (paginated)' })
  @ApiParam({ name: 'accountId', description: 'Account UUID' })
  @ApiQuery({ name: 'txCode', description: 'Filter by transaction code e.g. 2201,2202', required: false })
  @ApiResponse({ status: 200, description: 'Paginated transactions for the specified account' })
  findByAccount(
    @Param('accountId') accountId: string,
    @Query() paginationDto: PaginationDto,
    @Query('txCode') txCode?: string,
  ) {
    return this.transactionsService.findByAccount(accountId, paginationDto, txCode);
  }

  @Get('account/:accountId/payments')
  @ApiOperation({
    summary: 'Get only payment/withdrawal transactions (tx code 3101) for an account',
    description: 'Same query logic as /account/:accountId but hard-filtered to SAVINGS_TX_CODE 3101.',
  })
  @ApiParam({ name: 'accountId', description: 'Account Number' })
  @ApiResponse({ status: 200, description: 'Paginated 3101 transactions' })
  findPayments(
    @Param('accountId') accountId: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.transactionsService.findByAccount(accountId, paginationDto, '3101');
  }

  @Get('account/:accountId/year/:year')
  @ApiOperation({ summary: 'Get account transactions filtered by year (paginated)' })
  @ApiParam({ name: 'accountId', description: 'Account Number (e.g., 12345)' })
  @ApiParam({ name: 'year', description: 'Year e.g. 2025', type: Number })
  @ApiQuery({ name: 'txCode', description: 'Filter by transaction code e.g. 2201,2202', required: false })
  @ApiResponse({ status: 200, description: 'Paginated transactions for account in specified year' })
  findByAccountAndYear(
    @Param('accountId') accountId: string,
    @Param('year') year: string,
    @Query() paginationDto: PaginationDto,
    @Query('txCode') txCode?: string,
  ) {
    return this.transactionsService.findByAccountAndYear(accountId, parseInt(year, 10), paginationDto, txCode);
  }
}
