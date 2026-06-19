import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Update a client's request_name from the checkout screen. */
export class UpdateClientRequestNameDto {
  @ApiProperty({
    example: 'ທ. ສົມສີ ສີໄຊ',
    description: 'New request_name to store on the client record',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  requestName: string;

  @ApiPropertyOptional({ example: '0101001', description: 'Expected vbCode (ownership guard)' })
  @IsOptional()
  @IsString()
  vbCode?: string;
}
