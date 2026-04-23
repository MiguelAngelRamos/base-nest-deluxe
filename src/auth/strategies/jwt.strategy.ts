// src/auth/strategies/jwt.strategy.ts

import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type Redis from 'ioredis';
import { UsersService } from '../../users/users.service';

// Payload que metemos dentro del access token
// sub — subject standard claim, almacena el userId
// email y role los incluimos para evitar un lookup en DB
// en cada request autenticado. Son datos públicos del usuario
export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  // jti (JWT ID) — identificador único; prerequisito para blocklist en logout.
  jti: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {

  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    @Inject('VALKEY_CLIENT')
    private readonly valkeyClient: Redis,
  ) {
    // OWASP A02:2025 — Cryptographic Failures
    // El secreto se lee del .env en tiempo de construcción
    // nunca hardcoded. ignoreExpiration: false asegura que
    // tokens expirados sean rechazados automáticamente
    const secret = configService.get<string>('jwt.secret');

    if (!secret) {
      throw new Error('JWT_SECRET no está definido en .env');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      //* [SECURE-FIX V2] algorithms pineado a HS256 — bloquea
      //* ataques de algorithm confusion (alg:none, HS/RS mix).
      //* OWASP ASVS V3.5.
      algorithms: ['HS256'],
      //* [SECURE-FIX V3] issuer + audience validados aquí; si
      //* un token no trae estos claims o trae otros, se rechaza
      //* antes de pasar por validate().
      issuer: configService.getOrThrow<string>('jwt.issuer'),
      audience: configService.getOrThrow<string>('jwt.audience'),
    });
  }

  // validate() se ejecuta después de que passport-jwt valida
  // la firma y expiración del token. Lo que retornemos aquí
  // se adjunta a req.user en los controladores protegidos
  async validate(payload: JwtPayload) {
    // Verificamos en cada request que el usuario siga existiendo
    // y esté activo — soft delete debe revocar tokens emitidos
    // OWASP A01: Broken Access Control — un usuario desactivado
    // no debe poder usar su token aunque aún no haya expirado
    const user = await this.usersService.findOne(payload.sub);

    if (!user.isActive) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    // [SECURE-FIX] Blocklist check — si el jti está en Valkey el token
    // fue revocado explícitamente en logout. OWASP A07:2021.
    // Fail-open deliberado: si Valkey no responde, dejamos pasar.
    // isActive sigue siendo la defensa principal — un usuario desactivado
    // no puede usar su token aunque la blocklist esté caída.
    // OWASP A09:2021 — registrar el fallo para alertar si es recurrente.
    try {
      const blocked = await this.valkeyClient.get(`blocklist:at:${payload.jti}`);
      if (blocked) {
        throw new UnauthorizedException('Token revocado');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error(
        `Valkey blocklist check fallido — fail-open: ${(err as Error).message}`,
      );
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
