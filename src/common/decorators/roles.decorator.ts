// src/common/decorators/roles.decorator.ts

import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../users/entities/user.entity';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Sin RBAC (#3)
// Mitigación: decorador @Roles(...UserRole[]) que añade
//   metadata al handler/clase; RolesGuard la lee y verifica
//   que req.user.role esté en la lista permitida.
// Justificación OWASP A01 Broken Access Control: traslada
//   la política de acceso a una declaración verificable
//   en el controlador, en lugar de asumir que JWT válido = permitido.
// ─────────────────────────────────────────────
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
