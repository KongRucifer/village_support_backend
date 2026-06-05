import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'ltsventure-jwt-secret-key',
    });
  }

  async validate(payload: any) {
    // Payload contains: sub (clientId), bankbookNumber, vbCode, type, iat, exp
    if (!payload.sub || !payload.type || payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token');
    }
    
    // Check if token is expired (Passport should handle this, but double-check)
    if (payload.exp && Date.now() >= payload.exp * 1000) {
      throw new UnauthorizedException('Token has expired');
    }

    return {
      bankbookNumber: payload.sub,
      vbCode: payload.vbCode,
    };
  }
}
