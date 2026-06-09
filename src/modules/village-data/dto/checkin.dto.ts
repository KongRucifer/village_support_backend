import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CheckInDto {
  @IsOptional()
  @IsString()
  vbCode?: string;

  /** Fixed deposit added to the member's savings balance on check-in (e.g. 195000). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount?: number;
}
