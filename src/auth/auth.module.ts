// src/auth/auth.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';

@Module({
  imports: [
    // UsersModule exporta UsersService — necesario en AuthService
    // para buscar usuarios por email y delegar la creación
    UsersModule,

    // TypeOrmModule.forFeature([User]) — AuthService necesita
    // acceso directo al repositorio para manipular refreshTokenHash
    // que UsersService intencionalmente no expone (pertenece a auth)
    TypeOrmModule.forFeature([User]),

    // PassportModule.register({ defaultStrategy: 'jwt' }) —
    // registra Passport globalmente en este módulo
    PassportModule.register({ defaultStrategy: 'jwt' }),

    // JwtModule.registerAsync — configura el servicio JWT con
    // valores del .env. Async porque ConfigService necesita estar
    // listo antes de leer las variables
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => ({
        // Secret por defecto — usado para access tokens
        // El refresh usa un secret distinto y se configura en el
        // sign/verify manualmente en AuthService/AuthController
        secret: configService.getOrThrow<string>('jwt.secret'),
        signOptions: {
          // Cast necesario porque jsonwebtoken restringe expiresIn
          // a ms.StringValue (template-literal) y nuestro config
          // entrega string plano. El valor real ('15m', '7d') es
          // válido en runtime
          expiresIn: configService.getOrThrow<string>(
            'jwt.expiration',
          ) as unknown as number,
          //* [SECURE-FIX V2+V3] algoritmo pineado y claims estándar
          //* — todos los tokens emitidos llevan iss/aud y se firman
          //* con HS256 explícito. Cualquier caller que use jwtService
          //* hereda estos valores.
          algorithm: 'HS256',
          issuer: configService.getOrThrow<string>('jwt.issuer'),
          audience: configService.getOrThrow<string>('jwt.audience'),
        },
        //* [SECURE-FIX V2+V3] defaults de verify — JwtService.verifyAsync
        //* exige HS256 + iss + aud salvo que el caller sobreescriba.
        verifyOptions: {
          algorithms: ['HS256'],
          issuer: configService.getOrThrow<string>('jwt.issuer'),
          audience: configService.getOrThrow<string>('jwt.audience'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy],
  // Exportamos AuthService y JwtAuthGuard indirectamente
  // (vía PassportModule) para que otros módulos puedan aplicar
  // la protección con @UseGuards(JwtAuthGuard)
  exports: [AuthService],
})
export class AuthModule {}
