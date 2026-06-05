import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

// Plain TS enum stored as VARCHAR(20) in the DB (not a PostgreSQL native enum).
export enum PaymentMethod {
  Cash = 'Cash',
  BankTransfer = 'BankTransfer',
}

/** Withdraw (cut) an amount from an account's savings balance. */
export class WithdrawDto {
  @ApiProperty({ example: 50000, description: 'Amount to withdraw from savings' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount: number;

  @ApiProperty({
    enum: PaymentMethod,
    default: PaymentMethod.Cash,
    example: PaymentMethod.Cash,
    description: 'Payment method: Cash or BankTransfer',
  })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod = PaymentMethod.Cash;

  @ApiPropertyOptional({ example: '0101001', description: 'Expected vbCode (ownership guard)' })
  @IsOptional()
  @IsString()
  vbCode?: string;

  @ApiPropertyOptional({ example: 'QR withdraw', description: 'Optional note' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    example: 'ທ. ສົມສີ ສີໄຊ',
    description: 'ຊື່ຜູ້ຮັບ (Bank Transfer only) — saved to client.request_name',
  })
  @IsOptional()
  @IsString()
  requestName?: string;

  @ApiPropertyOptional({
    example: '010100100000001',
    description: 'ເລກບັນຊີຜູ້ຮັບ (Bank Transfer only) — saved to client.request_acc_number',
  })
  @IsOptional()
  @IsString()
  requestAccNumber?: string;
}
