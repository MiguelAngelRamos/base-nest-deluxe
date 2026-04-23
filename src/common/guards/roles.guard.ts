// src/common/guards/roles.guard.ts

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole } from '../../users/entities/user.entity';
import type { AuthenticatedUser } from '../types/authenticated-user.interface';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Sin RBAC (#3)
// Mitigación: guard que corre después de JwtAuthGuard y verifica
//   que req.user.role esté entre los roles declarados con @Roles().
//   Si no hay @Roles en el handler, permite el paso (auth-only).
// Justificación OWASP A01 Broken Access Control + A04:
//   cierra el hueco donde cualquier token válido podía ejecutar
//   cualquier mutación sensible (crear admins, borrar médicos,
//   eliminar especialidades, etc.). Lanza 403 Forbidden — no 401 —
//   porque el principal sí está autenticado, solo carece de permiso.
// ─────────────────────────────────────────────
@Injectable()
export class RolesGuard implements CanActivate {

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // getAllAndOverride combina metadata de método y clase —
    // el método prevalece si ambos tienen @Roles
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sin @Roles en el handler/clase — este guard no opina.
    // El JwtAuthGuard ya se aseguró de que haya usuario autenticado.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        'No tienes permisos para acceder a este recurso',
      );
    }

    return true;
  }
}
