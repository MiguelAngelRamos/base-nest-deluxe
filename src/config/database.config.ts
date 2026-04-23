// src/config/database.config.ts

import { registerAs } from '@nestjs/config';

// Namespace 'database' — acceso: configService.get('database.host')
export default registerAs('database', () => ({
  host: process.env.DB_HOST,
  port: Number.parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  name: process.env.DB_NAME,
  //* [SECURE-FIX V6] SSL ahora viene de env en lugar de estar
  //* hardcoded en app.module.ts. En desarrollo local contra
  //* 192.168.1.51 LAN sin certificado queda false — funciona igual.
  //* En despliegue se activa seteando DB_SSL=true.
  //! [PROD] DB_SSL=true en el .env de producción + el DataSource
  //!        debe usar { rejectUnauthorized: true } contra la CA
  //!        del proveedor (RDS/Cloud SQL/Supabase). Usar ssl:false
  //!        con una DB pública expone credenciales y PHI clínica.
  ssl: process.env.DB_SSL === 'true',
}));
