// ormconfig.ts
// Configuración exclusiva para el CLI de TypeORM
// Este archivo NO forma parte de NestJS —
// solo lo usa el CLI para crear y ejecutar migraciones

import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

// Cargamos el .env manualmente porque estamos fuera de NestJS
// y no tenemos acceso al ConfigModule
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  // TypeORM busca las entidades compiladas en dist/
  // porque el CLI trabaja con JavaScript, no TypeScript
  entities: ['dist/src/**/*.entity.js'],

  // TypeORM busca las migraciones compiladas en dist/
  migrations: ['dist/src/database/migrations/*.js'],

  // synchronize siempre en false —
  // los cambios al esquema se hacen solo mediante migraciones
  synchronize: false,

  // logging activado para ver las queries durante migraciones
  logging: true,

  //* [SECURE-FIX V6] ormconfig.ts corre el CLI de TypeORM (migraciones),
  //* no el runtime de Nest. En dev local se mantiene ssl:false para
  //* no bloquear `pnpm migration:run`.
  //! [PROD] Antes de correr migraciones contra una DB gestionada
  //!        reemplazar por: ssl: { rejectUnauthorized: true }
  //!        y asegurar que el proceso de CI carga el .env de prod.
  ssl: process.env.DB_SSL === 'true',
});