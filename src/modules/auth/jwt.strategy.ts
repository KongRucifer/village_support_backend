import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

const JWT_FALLBACK = 'ltsventure-village-support-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || JWT_FALLBACK,
    });
  }

  async validate(payload: any) {
    if (!payload.sub || !payload.type || payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token');
    }

    // System user token: sub = "sys:<id>"
    if (String(payload.sub).startsWith('sys:')) {
      return {
        id: payload.sub,
        userName: payload.userName,
        role: payload.role,
      };
    }

    // Client token: sub = bankbookNumber
    return {
      bankbookNumber: payload.sub,
      vbCode: payload.vbCode,
    };
  }
}
