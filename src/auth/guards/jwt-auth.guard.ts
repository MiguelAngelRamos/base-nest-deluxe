// src/auth/guards/jwt-auth.guard.ts

import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

// JwtAuthGuard hereda toda la lógica de AuthGuard('jwt') de Passport
// La existencia de esta clase sirve para dos cosas:
// 1. Dar un nombre legible en el código — @UseGuards(JwtAuthGuard)
//    es más claro que @UseGuards(AuthGuard('jwt'))
// 2. Permitir extender el comportamiento (por ej. manejo de roles)
//    en el futuro sin tocar todos los controladores
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {

  //* [SECURE-FIX V4] Reflector inyectado para leer el metadata que
  //* deja el decorador @Public(). Al registrar este guard como
  //* APP_GUARD, todos los endpoints exigen JWT por defecto — los
  //* que deben quedar abiertos (login/register/refresh/health) se
  //* marcan explícitamente con @Public() y este canActivate devuelve
  //* true sin pasar por Passport.
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
