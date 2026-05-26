// src/config/jwt.config.ts

import { registerAs } from '@nestjs/config';

//* [SECURE-FIX V7] Longitud mínima recomendada por OWASP ASVS V2.10
//* para HS256 — 32 bytes aleatorios. Menos que eso abre la puerta a
//* brute force offline del secret si el hash HMAC queda expuesto.
const MIN_SECRET_LENGTH = 32;

//* [SECURE-FIX V7] Validador dual: en producción cualquier secreto
//* débil aborta el arranque (fail fast); en desarrollo solo emite
//* warning para no entorpecer el flujo local con secretos placeholder,
//* pero deja constancia en consola de que hay que rotar.
//! [PROD] Rotar ambos secretos antes de desplegar:
//!        openssl rand -base64 48
//!        node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
//!        y escribirlos en JWT_SECRET / JWT_REFRESH_SECRET del .env
//!        de producción. NUNCA reutilizar los valores de dev/staging.
function assertSecret(name: string, value: string | undefined): string {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    const msg =
      `${name} debe tener al menos ${MIN_SECRET_LENGTH} caracteres ` +
      `aleatorios (usa: openssl rand -base64 48)`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }

    console.warn(`[jwt.config] WARN ${msg}`);
  }
  return value ?? '';
}

// Namespace 'jwt' — acceso: configService.get('jwt.secret')
export default registerAs('jwt', () => ({
  //* [SECURE-FIX V7] Validación al cargar la config. Si el entorno es
  //* producción y los secretos son débiles, el proceso muere antes de
  //* aceptar el primer request — evita emitir tokens firmables a la fuerza.
  secret: assertSecret('JWT_SECRET', process.env.JWT_SECRET),
  expiration: process.env.JWT_EXPIRATION || '15m',
  refreshSecret: assertSecret(
    'JWT_REFRESH_SECRET',
    process.env.JWT_REFRESH_SECRET,
  ),
  refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
  //* [SECURE-FIX V3] iss/aud para que los tokens emitidos por este
  //* servicio no sean aceptados por otros servicios con el mismo
  //* secreto (y viceversa). Se validan en firma y verify — OWASP ASVS V3.5.
  issuer: process.env.JWT_ISSUER || 'clinic-api',
  audience: process.env.JWT_AUDIENCE || 'clinic-web',
}));
