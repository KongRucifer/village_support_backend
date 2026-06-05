import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    // Add your custom authentication logic here
    // for example, call super.logIn(request) to establish a session.
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any) {
    // You can throw an exception based on either "info" or "err" arguments
    if (err || !user) {
      // Handle specific JWT errors
      if (info instanceof TokenExpiredError) {
        throw new UnauthorizedException({
          message: 'Token has expired',
          code: 'TOKEN_EXPIRED',
          expiredAt: info.expiredAt,
        });
      }
      
      if (info instanceof JsonWebTokenError) {
        throw new UnauthorizedException({
          message: 'Invalid token',
          code: 'TOKEN_INVALID',
        });
      }

      throw err || new UnauthorizedException('Unauthorized');
    }
    return user;
  }
}
