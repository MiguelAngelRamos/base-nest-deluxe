// src/config/valkey.config.ts

import { registerAs } from '@nestjs/config';

// Namespace 'valkey' — acceso: configService.get('valkey.host')
export default registerAs('valkey', () => ({
  host: process.env.VALKEY_HOST || '127.0.0.1',
  port: Number.parseInt(process.env.VALKEY_PORT || '6379', 10),
  password: process.env.VALKEY_PASSWORD || undefined,
}));
