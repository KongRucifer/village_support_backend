import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SystemLoginDto {
  @ApiProperty({ example: 'admin', description: 'System user name' })
  @IsString()
  @IsNotEmpty()
  userName: string;

  @ApiProperty({ example: 'admin12345678', description: 'System user password' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
