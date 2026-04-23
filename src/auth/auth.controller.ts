// src/auth/auth.controller.ts

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
//* [SECURE-FIX V4] @Public() abre explícitamente los endpoints de
//* auth (login, register, refresh) ahora que JwtAuthGuard es global.
//* logout sigue requiriendo token — es un caso de uso autenticado.
import { Public } from '../common/decorators/public.decorator';

// Nombre de la cookie del refresh token — constante compartida
// entre login, refresh y logout para mantener consistencia
const REFRESH_COOKIE = 'refresh_token';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Cookie refresh_token con path: '/' (#12) — se
//   enviaba en cualquier request al mismo dominio, ampliando
//   innecesariamente la superficie de exposición.
// Mitigación: scope limitado al único endpoint que realmente la
//   consume — /api/v1/auth/refresh. El browser no la incluirá en
//   otros paths. clearCookie debe usar el mismo path para invalidar.
// Justificación OWASP A01 + A05: aplicar least-privilege también
//   a cookies — se envían solo donde son necesarias.
// ─────────────────────────────────────────────
const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';

@ApiTags('auth')
@Controller('auth')
export class AuthController {

  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: Sin rate limiting en /auth/register (#5) —
  //   permitía creación masiva de cuentas para abusar del sistema.
  // Mitigación: 5 registros por IP cada 10 minutos.
  // Justificación OWASP A07 + A04: limita bot-signups y prevención
  //   de flooding de usuarios desechables en un endpoint público.
  // ─────────────────────────────────────────────
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  //* [SECURE-FIX V4] endpoint público — sin token el usuario aún no existe
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar nuevo usuario' })
  @ApiResponse({ status: 201, description: 'Usuario creado y autenticado' })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 409, description: 'Email ya registrado' })
  async register(
    @Body() registerDto: RegisterDto,
    // passthrough: true — deja que NestJS envíe la respuesta
    // automáticamente además de permitirnos setear cookies
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.register(registerDto);
    this.setRefreshCookie(res, tokens.refreshToken);
    // No devolvemos el refresh token en el body — solo en la
    // cookie HttpOnly. El access token sí va en el body para que
    // el cliente lo guarde en memoria y lo envíe en Authorization
    return {
      accessToken: tokens.accessToken,
      user: tokens.user,
    };
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: Sin rate limiting en /auth/login (#5) —
  //   permitía brute force y password spraying.
  // Mitigación: 5 intentos por IP por minuto. Combinado con Argon2id
  //   (~100ms/verify) se eleva el coste real de un ataque de diccionario.
  //   Para producción se recomienda complementar con lockout por cuenta
  //   tras N fallos consecutivos (no implementado en esta iteración).
  // Justificación OWASP A07 Identification and Authentication Failures:
  //   protección obligatoria contra ataques automatizados.
  // ─────────────────────────────────────────────
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  //* [SECURE-FIX V4] endpoint público — el token se obtiene AQUÍ
  @Public()
  // @UseGuards(LocalAuthGuard) ejecuta LocalStrategy.validate()
  // Passport inyecta el usuario validado en req.user
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión con email y contraseña' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Login exitoso' })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.login(
      loginDto.email,
      loginDto.password,
    );
    this.setRefreshCookie(res, tokens.refreshToken);
    return {
      accessToken: tokens.accessToken,
      user: tokens.user,
    };
  }

  //* [SECURE-FIX V5] Throttle explícito en refresh — 10 rpm por IP.
  //* Sin esto solo se aplicaba el default global (60 rpm), lo cual
  //* permitía a un atacante con refresh robado amplificar su acceso.
  //* OWASP A04 Insecure Design + A07 Authentication Failures.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  //* [SECURE-FIX V4] endpoint público — la cookie HttpOnly reemplaza
  //* al token Bearer como credencial. La autenticación la hace el
  //* verify del refresh dentro del handler, no el guard.
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar access token con refresh token' })
  @ApiResponse({ status: 200, description: 'Token renovado' })
  @ApiResponse({ status: 401, description: 'Refresh token inválido o expirado' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Leemos el refresh desde la cookie HttpOnly — NUNCA del body
    // ni del header. La cookie con sameSite: strict evita CSRF
    // OWASP A01:2021 — Broken Access Control
    const cookies = (req as Request & {
      cookies?: Record<string, string>;
    }).cookies;
    const refreshToken = cookies?.[REFRESH_COOKIE];

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token no presente');
    }

    // Verificamos firma y expiración del refresh antes de pegarle
    // a la DB — ahorra queries innecesarias si el token es basura
    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        //* [SECURE-FIX V2+V3] Verify pineado: HS256 + iss + aud.
        //* Cierra algorithm confusion y valida que el token haya
        //* sido emitido por esta API para este cliente.
        algorithms: ['HS256'],
        issuer: this.configService.getOrThrow<string>('jwt.issuer'),
        audience: this.configService.getOrThrow<string>('jwt.audience'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    const tokens = await this.authService.refreshToken(
      payload.sub,
      refreshToken,
    );
    this.setRefreshCookie(res, tokens.refreshToken);
    return {
      accessToken: tokens.accessToken,
      user: tokens.user,
    };
  }

  // Logout requiere access token válido — si no hay sesión no
  // tiene sentido invalidar nada. OWASP A01
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cerrar sesión e invalidar refresh token' })
  @ApiResponse({ status: 204, description: 'Logout exitoso' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  async logout(
    @Req() req: Request & { user: { id: string } },
    @Res({ passthrough: true }) res: Response,
  ) {
    // Extraemos el Bearer para pasarlo a la blocklist de Valkey.
    // El guard ya verificó su validez — aquí solo lo parseamos.
    const authHeader = (req.headers as Record<string, string>)['authorization'] ?? '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    await this.authService.logout(req.user.id, accessToken);
    //* [SECURE-FIX V5] clearCookie replica TODOS los flags con los
    //* que se seteó la cookie. Path es lo único imprescindible para
    //* que el navegador la identifique, pero mantener httpOnly/secure/
    //* sameSite consistentes evita ambigüedades si en el futuro se
    //* añade `domain` o cambian las reglas del navegador.
    res.clearCookie(REFRESH_COOKIE, this.buildRefreshCookieOptions());
  }

  // Cookie del refresh token — flags de seguridad:
  // httpOnly: true — inaccesible desde JavaScript, evita XSS robando tokens
  // secure: true siempre que no sea entorno local — solo HTTPS
  // sameSite: 'strict' — evita CSRF, el browser no envía la cookie en
  //   requests cross-site. OWASP A01:2021 — Broken Access Control
  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.buildRefreshCookieOptions(),
      //* maxAge solo se setea en Set-Cookie; clearCookie lo ignora
      //* y por eso lo mantenemos fuera del helper compartido.
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  //* [SECURE-FIX V4+V5] Opciones compartidas entre setRefreshCookie y
  //* clearCookie — single source of truth para los flags.
  //* secure se desactiva SOLO en development/test. Cualquier otro
  //* entorno (staging, preview, prod) exige HTTPS para la cookie,
  //* cerrando el hueco de que un NODE_ENV distinto a 'production'
  //* hiciera viajar el refresh en claro.
  //! [PROD] Confirmar que NODE_ENV del servidor de producción
  //!        vale exactamente 'production' (no 'prod' ni 'PROD').
  //!        Si alguien despliega con 'prod', secure queda en true
  //!        igual porque la condición es "cualquier cosa que no
  //!        sea development/test", pero conviene mantener la
  //!        convención estándar.
  private buildRefreshCookieOptions() {
    const env = this.configService.get<string>('app.nodeEnv');
    const secure = env !== 'development' && env !== 'test';
    return {
      httpOnly: true,
      secure,
      sameSite: 'strict' as const,
      path: REFRESH_COOKIE_PATH,
    };
  }
}
