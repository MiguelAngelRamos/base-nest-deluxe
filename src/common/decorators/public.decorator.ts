// src/common/decorators/public.decorator.ts

import { SetMetadata } from '@nestjs/common';

//* [SECURE-FIX V4] Decorador para marcar endpoints que deben quedar
//* accesibles sin JWT cuando el JwtAuthGuard está registrado como
//* APP_GUARD global. Sin este decorador, todo endpoint exige token.
//* Uso: @Public() sobre el handler de login/register/refresh/health.
//* Justificación OWASP A01: convertir "autenticación" en default y
//* forzar una declaración explícita para abrir un endpoint evita
//* regresiones (un controller nuevo queda protegido sin pensarlo).
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
