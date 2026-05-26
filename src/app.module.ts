// src/app.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
//* [SECURE-FIX V4] JwtAuthGuard se registra como APP_GUARD global
//* más abajo — por eso se importa aquí además del AuthModule.
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { ValkeyModule } from './valkey/valkey.module';

// Importamos las configuraciones desde el barrel export
import { appConfig, databaseConfig, jwtConfig, valkeyConfig } from './config';
import { UsersModule } from './users/users.module';
import { PatientsModule } from './patients/patients.module';
import { DoctorsModule } from './doctors/doctors.module';
import { SpecialtiesModule } from './specialties/specialties.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    // ConfigModule es el módulo oficial de NestJS para
    // gestionar variables de entorno
    ConfigModule.forRoot({
      // isGlobal: true — hace que ConfigModule esté disponible
      // en TODOS los módulos sin necesidad de importarlo
      // en cada uno — lo registramos una sola vez aquí
      isGlobal: true,

      // load — array de configuraciones con namespace
      // cada registerAs() que creamos se registra aquí
      load: [appConfig, databaseConfig, jwtConfig, valkeyConfig],

      // envFilePath — ruta al archivo .env
      // por defecto busca .env en la raíz del proyecto
      envFilePath: '.env',

      // cache: true — NestJS cachea las variables de entorno
      // en memoria después de la primera lectura
      // mejora el rendimiento en aplicaciones con muchas
      // llamadas a configService.get()
      cache: true,
    }),

    // Paso 2 — TypeOrmModule se conecta a PostgreSQL
    // forRootAsync espera a que ConfigModule termine
    // antes de intentar leer las variables de entorno
    // Si usáramos forRoot() en lugar de forRootAsync()
    // las variables aún no estarían disponibles — error silencioso
    TypeOrmModule.forRootAsync({
      // inject le dice a NestJS qué dependencias inyectar
      // en la función useFactory
      inject: [ConfigService],

      // useFactory es una función que retorna la configuración
      // NestJS la llama automáticamente con ConfigService inyectado
      useFactory: (configService: ConfigService) => ({
        // Tipo de base de datos
        type: 'postgres',

        // Leemos las variables desde el namespace 'database'
        // que definimos en database.config.ts con registerAs
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.name'),

        // entities — TypeORM busca las entidades aquí
        // __dirname apunta a la carpeta actual en runtime
        // El patrón *.entity.{ts,js} encuentra todos los archivos
        // de entidades automáticamente sin registrarlos uno por uno
        entities: [__dirname + '/**/*.entity.{ts,js}'],

        // synchronize: false — SIEMPRE false, en desarrollo Y producción
        // Si lo cambias a true, TypeORM modificará o eliminará columnas
        // automáticamente comparando entidades vs tablas reales
        // pudiendo causar pérdida de datos irreversible
        // Los cambios al esquema se hacen SOLO mediante migraciones explícitas
        synchronize: false,

        // logging: true en desarrollo — muestra las queries
        // SQL que TypeORM genera — muy útil para aprender
        // En producción esto se desactiva
        logging: configService.get<string>('app.nodeEnv') === 'development',

        //* [SECURE-FIX V6] SSL leído de config (DB_SSL env) en lugar
        //* de hardcode. En dev local sigue siendo false automáticamente.
        //! [PROD] Al desplegar, setear DB_SSL=true en el entorno y
        //!        reemplazar el booleano por { rejectUnauthorized: true }
        //!        apuntando al certificado CA del proveedor de DB.
        ssl: configService.get<boolean>('database.ssl') ?? false,
      }),
    }),

    // ─────────────────────────────────────────────
    // [SECURE-FIX] A04 - Insecure Design
    // Vulnerabilidad: Sin rate limiting / lockout en /auth/login (#5)
    // Mitigación: ThrottlerModule global con baseline de 60 rpm por IP.
    //   Endpoints sensibles (login, register) reciben límites más
    //   estrictos vía @Throttle() en sus handlers.
    // Justificación OWASP A07:2021 Identification and Authentication
    //   Failures + A04: rate limiting es el control mínimo para
    //   mitigar brute force y credential stuffing sin requerir
    //   infraestructura externa (Redis, WAF).
    // ─────────────────────────────────────────────
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 60,
      },
    ]),

    // CacheModule global — store en memoria para uso general.
    // La blocklist usa ioredis directamente vía ValkeyModule.
    CacheModule.register({ isGlobal: true }),

    // ValkeyModule global — provee VALKEY_CLIENT (ioredis) para
    // la blocklist de access tokens en logout. Fail-open si Valkey
    // no está disponible al arrancar. OWASP A07:2021.
    ValkeyModule,

    UsersModule,

    PatientsModule,

    DoctorsModule,

    SpecialtiesModule,

    AppointmentsModule,

    AuthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // ThrottlerGuard registrado como guard global — activo en
    // todos los endpoints. Handlers sin @Throttle() usan el default.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    //* [SECURE-FIX V4] JwtAuthGuard global — todo endpoint exige
    //* token por defecto. Los públicos (login, register, refresh,
    //* health) se marcan con @Public(). Cierra el riesgo de crear
    //* un controller nuevo sin @UseGuards y dejarlo abierto por
    //* olvido. OWASP A01: authentication-by-default.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
