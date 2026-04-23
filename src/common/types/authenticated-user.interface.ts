// src/common/types/authenticated-user.interface.ts

import { UserRole } from '../../users/entities/user.entity';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Sin RBAC / IDOR (#3, #4)
// Mitigación: tipo canónico del usuario autenticado que
//   viaja en req.user tras pasar JwtAuthGuard. Evita que
//   cada capa redescubra la forma del objeto.
// Justificación OWASP A01/A04: centralizar el contrato del
//   principal autenticado facilita auditar las decisiones de
//   autorización y previene checks ad-hoc inconsistentes.
// ─────────────────────────────────────────────
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}
