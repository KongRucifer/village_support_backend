import { Injectable, UnauthorizedException, InternalServerErrorException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SystemLoginDto } from './dto/system-login.dto.js';

export interface SystemTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: Date;
  user: {
    id: number;
    userName: string;
    nsoEmployeeId: string | null;
    statusId: string;
    roles: string[];
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async loginSystemUser(dto: SystemLoginDto): Promise<SystemTokenResponse> {
    const user = await this.prisma.systemUser.findFirst({
      where: { userName: dto.userName },
      include: {
        roles: { include: { systemRole: true } },
      },
    }).catch((err: unknown) => {
      this.logger.error('Database error during login', err);
      throw new InternalServerErrorException('Database connection failed');
    });

    if (!user) {
      throw new UnauthorizedException('Username is incorrect');
    }

    if (!user.password) {
      throw new UnauthorizedException('This account has no password set');
    }

    // Support bcrypt-hashed and legacy plaintext passwords.
    const looksHashed = /^\$2[aby]\$/.test(user.password);
    const isPasswordValid = looksHashed
      ? await bcrypt.compare(dto.password, user.password)
      : dto.password === user.password;

    if (!isPasswordValid) {
      throw new UnauthorizedException('Password is incorrect');
    }

    // sub = "sys:<id>" to avoid collision with client tokens.
    const payload = {
      sub: `sys:${user.id}`,
      userName: user.userName,
      role: 'system',
      type: 'access',
    };

    const expiresIn = 30 * 60; // 30 minutes in seconds
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: `${expiresIn}s`,
    });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      expiresAt,
      user: {
        id: user.id,
        userName: user.userName,
        nsoEmployeeId: user.nsoEmployeeId,
        statusId: user.statusId,
        roles: user.roles.map((r) => r.systemRole.nameEng),
      },
    };
  }
}
