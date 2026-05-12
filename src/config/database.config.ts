// src/config/database.config.ts

import { registerAs } from '@nestjs/config';

// Namespace 'database' — acceso: configService.get('database.host')
export default registerAs('database', () => ({
  host: process.env.DB_HOST,
  port: Number.parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  name: process.env.DB_NAME,
  // DB_SSL cifra el canal TCP entre NestJS y PostgreSQL con TLS.
  // Sin SSL, usuario, contraseña y queries viajan en texto plano.
  //
  // DB_SSL=false  → desarrollo local en LAN (192.168.1.51).
  //                 El Postgres local no tiene certificado; false es correcto.
  // DB_SSL=true   → producción en la nube (RDS, Supabase, Cloud SQL, etc.).
  //                 La conexión cruza internet: cifrado obligatorio.
  //
  //! En prod también configurar { rejectUnauthorized: true } en el DataSource
  //! para validar el certificado del proveedor y evitar ataques MITM.
  //
  // CÓMO FUNCIONA ESTA LÍNEA:
  // process.env.DB_SSL siempre llega como STRING desde el .env ("true" o "false").
  // El operador === 'true' convierte ese string a boolean:
  //   .env: DB_SSL=false  →  "false" === 'true'  →  false  (SSL desactivado)
  //   .env: DB_SSL=true   →  "true"  === 'true'  →  true   (SSL activado)
  // Es un conversor, no una asignación. El .env es quien manda.

  // DB_SSL llega del .env siempre como STRING ("true" o "false"), nunca como boolean.
  // El operador === 'true' convierte ese string a boolean real que TypeORM entiende:
  //   .env: DB_SSL=false  →  "false" === 'true'  →  false  (SSL desactivado)
  //   .env: DB_SSL=true   →  "true"  === 'true'  →  true   (SSL activado)
  // database.config.ts nunca decide el valor — solo lee y transforma.
  // El .env es la única fuente de verdad.
  ssl: process.env.DB_SSL === 'true',
}));
