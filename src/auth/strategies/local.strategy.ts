// src/auth/strategies/local.strategy.ts

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly authService: AuthService) {
    // Por defecto passport-local espera los campos 'username' y
    // 'password'. Renombramos username → email porque nuestra
    // API autentica por email, no por username
    super({ usernameField: 'email' });
  }

  // passport-local llama validate(email, password) automáticamente
  // con los valores del body. Si retorna user, lo adjunta a req.user
  // Si lanza excepción, Passport responde 401 automáticamente
  async validate(email: string, password: string) {
    const user = await this.authService.validateUser(email, password);

    if (!user) {
      // OWASP A07:2021 — Identification and Authentication Failures
      // Mensaje genérico intencional — no revelar si el email existe
      // o si solo la contraseña es incorrecta previene enumeración
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return user;
  }
}
