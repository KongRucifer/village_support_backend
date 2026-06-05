import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService, SystemTokenResponse } from './auth.service.js';
import { SystemLoginDto } from './dto/system-login.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login-test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login (system user) — authenticate and return a JWT access token',
    description:
      'Used by the village_support_app Flutter app. Validates userName + password ' +
      'against the system_user table and returns a 30-minute Bearer token.',
  })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  loginTest(@Body() dto: SystemLoginDto): Promise<SystemTokenResponse> {
    return this.authService.loginSystemUser(dto);
  }
}
