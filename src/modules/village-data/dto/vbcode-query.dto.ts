import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto.js';

/** Query for the VbCode list — paginated + free-text search on code / name. */
export class VbCodeQueryDto extends PaginationDto {}

/** Query for the AccountOwner list — scoped to a VbCode, optionally a bankbook. */
export class AccountOwnerQueryDto extends PaginationDto {
  @ApiPropertyOptional({ example: '0101001', description: 'Village bank code (vbcode)' })
  @IsOptional()
  @IsString()
  vbCode?: string;

  @ApiPropertyOptional({ example: '00001', description: 'Bankbook number to filter owners' })
  @IsOptional()
  @IsString()
  bankbookNumber?: string;
}
