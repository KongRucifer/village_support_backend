import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/** Edit the savings (deposit) balance of an account. */
export class UpdateSavingsDto {
  @ApiProperty({ example: 1500000, description: 'New current balance (savings) for the account' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  currentBalance: number;

  @ApiPropertyOptional({ example: '0101001', description: 'Expected vbCode (ownership guard)' })
  @IsOptional()
  @IsString()
  vbCode?: string;

  @ApiPropertyOptional({ example: 'Offline deposit correction', description: 'Optional note' })
  @IsOptional()
  @IsString()
  note?: string;
}
