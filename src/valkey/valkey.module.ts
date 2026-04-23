// src/valkey/valkey.module.ts

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'VALKEY_CLIENT',
      inject: [ConfigService],
      // [SECURE-FIX] Fail-open en arranque: si Valkey no está disponible
      // la app inicia igualmente — la blocklist queda degradada pero
      // isActive sigue siendo la defensa principal. Cualquier comando
      // posterior que falle en services/strategies se captura allí.
      // OWASP A09:2021 — registrar el fallo para visibilidad operacional.
      useFactory: async (cs: ConfigService) => {
        const logger = new Logger('ValkeyClient');
        const host = cs.getOrThrow<string>('valkey.host');
        const port = cs.getOrThrow<number>('valkey.port');
        const password = cs.get<string>('valkey.password');

        const client = new Redis({ host, port, password, lazyConnect: true });

        // Listener de errores post-arranque (desconexiones, timeouts)
        // evita que queden como unhandled rejection y caigan el proceso
        client.on('error', (err: Error) => {
          logger.error(`Valkey error: ${err.message}`);
        });

        try {
          await client.connect();
          logger.log(`Valkey conectado en ${host}:${port}`);
        } catch {
          logger.error(
            `Valkey no disponible al arrancar (${host}:${port}) — operando sin blocklist`,
          );
        }

        return client;
      },
    },
  ],
  exports: ['VALKEY_CLIENT'],
})
export class ValkeyModule {}
