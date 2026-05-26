// src/common/decorators/current-user.decorator.ts

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: IDOR (#4)
// Mitigación: @CurrentUser() extrae req.user inyectado por
//   JwtAuthGuard. Permite pasar el principal autenticado como
//   argumento tipado al servicio, donde se hacen los checks
//   de ownership de manera explícita y testeable.
// Justificación OWASP A01 Broken Access Control: evita que
//   los servicios confíen ciegamente en parámetros de URL y
//   obliga a contrastar "quién pide" vs "qué recurso".
// ─────────────────────────────────────────────
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
