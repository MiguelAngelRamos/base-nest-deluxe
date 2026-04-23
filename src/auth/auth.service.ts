// src/auth/auth.service.ts

import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './strategies/jwt.strategy';

// Objeto retornado por login/refresh — expuesto al cliente
// Nunca incluye passwordHash ni refreshTokenHash
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: string;
  };
}

@Injectable()
export class AuthService {

  // Logger con contexto del servicio — facilita filtrar logs
  // por módulo en producción. OWASP A09: Security Logging
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: Privilege escalation en /auth/register (#1)
  //   + doble path de hashing inconsistente (#2)
  // Mitigación:
  //   1) El rol se fuerza a UserRole.PATIENT en servidor. El
  //      cliente ya no puede escoger crearse como admin/doctor.
  //   2) Se elimina el pre-hash aquí; UsersService.create es el
  //      único responsable de hashear con Argon2id.
  // Justificación OWASP A01 Broken Access Control + A04:
  //   la asignación de privilegios debe ocurrir en servidor y
  //   nunca basarse en input del cliente en un endpoint público.
  //   OWASP A02:2025: un solo punto de hashing garantiza el invariante.
  // ─────────────────────────────────────────────
  async register(registerDto: RegisterDto): Promise<AuthTokens> {
    const user = await this.usersService.create({
      email: registerDto.email,
      password: registerDto.password,
      role: UserRole.PATIENT,
    });

    this.logger.log(`Nuevo usuario registrado: ${user.email}`);

    return this.issueTokens(user);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    // OWASP A09:2021 — Security Logging and Monitoring Failures
    // Registramos el intento sin exponer la contraseña en el log
    this.logger.log(`Intento de login para: ${email}`);

    const user = await this.validateUser(email, password);

    if (!user) {
      // Log de auditoría de intento fallido — permite detectar
      // ataques de fuerza bruta analizando logs por email/IP
      this.logger.warn(`Login fallido para email: ${email}`);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return this.issueTokens(user);
  }

  // validateUser — usado por LocalStrategy y por login()
  // Retorna User si las credenciales son válidas, null si no
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersService.findByEmail(email);

    // Si el usuario no existe o está desactivado retornamos null
    // sin indicar al atacante cuál de las dos condiciones falla
    if (!user || !user.isActive) {
      return null;
    }

    // argon2.verify() hace comparación en tiempo constante
    // evitando timing attacks — OWASP A02:2025
    const valid = await argon2.verify(user.passwordHash, password);

    if (!valid) {
      return null;
    }

    return user;
  }

  async refreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<AuthTokens> {
    // Cargamos el usuario con refreshTokenHash — findOne del servicio
    // lo excluye con select, así que aquí usamos el repo directo
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Refresh token inválido');
    }

    //* [SECURE-FIX V1] Reuse detection — caso "sin hash activo".
    //* Si el usuario no tiene refreshTokenHash pero llega un refresh
    //* con firma válida, significa que: (a) ya hizo logout y alguien
    //* reenvía un token antiguo, o (b) la familia ya fue revocada por
    //* un reuso anterior. En ambos casos rechazamos.
    if (!user.refreshTokenHash) {
      this.logger.warn(
        `Refresh sin hash activo para userId ${userId} — posible reuso post-logout`,
      );
      throw new UnauthorizedException('Refresh token inválido');
    }

    // Comparamos el refresh token recibido contra el hash guardado
    // Si alguien robara el hash de la DB no podría usarlo como token
    // porque requiere el token original para pasar la verificación
    const valid = await argon2.verify(user.refreshTokenHash, refreshToken);

    if (!valid) {
      //* [SECURE-FIX V1] Reuse detection — caso "hash no matchea".
      //* La firma del token es válida (ya se verificó en el controller),
      //* pero el hash almacenado es de un refresh posterior. Significa
      //* que alguien está presentando un token que ya fue rotado —
      //* casi seguro un token robado. Revocamos la familia completa
      //* (refreshTokenHash = null) para forzar re-login en todos los
      //* dispositivos y cortar al atacante. OWASP A07:2021 + A09.
      this.logger.error(
        `Refresh reuse detectado para userId ${userId}. Revocando familia.`,
      );
      await this.userRepository.update(userId, { refreshTokenHash: null });
      throw new UnauthorizedException(
        'Reuso de refresh token detectado. Sesión revocada.',
      );
    }

    // Rotación de refresh token — emitimos un par nuevo y
    // reemplazamos el hash. Si un token es robado, en cuanto el
    // usuario legítimo haga refresh, el token del atacante deja
    // de funcionar. OWASP A07:2021
    return this.issueTokens(user);
  }

  async logout(userId: string): Promise<void> {
    // Invalidamos el refresh token seteando el hash a null
    // El access token sigue válido hasta su expiración (15min)
    // Para revocación inmediata de access tokens se necesitaría
    // una lista de revocación — fuera del alcance de este módulo
    await this.userRepository.update(userId, { refreshTokenHash: null });
    this.logger.log(`Logout para userId: ${userId}`);
  }

  // issueTokens — firma access + refresh y guarda el hash del
  // refresh en DB. Método privado reutilizado por register/login/refresh
  private async issueTokens(user: User): Promise<AuthTokens> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    // Config de expiración como string ('15m', '7d') — @nestjs/jwt
    // la pasa internamente a la librería ms. Los tipos de jsonwebtoken
    // usan un template-literal union muy estricto (ms.StringValue) que
    // un string plano no satisface; casteamos el objeto de opciones
    // completo a JwtSignOptions para mantener el resto tipado
    //* [SECURE-FIX V2+V3] Cada signAsync recibe explícitamente
    //* algorithm + issuer + audience. @nestjs/jwt no siempre hereda
    //* los defaults del módulo cuando se pasa un objeto de opciones
    //* custom (override, no merge), así que lo hacemos explícito para
    //* que cada token emitido lleve los claims estándar sin importar
    //* cómo evolucione la lib.
    const issuer = this.configService.getOrThrow<string>('jwt.issuer');
    const audience = this.configService.getOrThrow<string>('jwt.audience');

    const accessOptions = {
      secret: this.configService.getOrThrow<string>('jwt.secret'),
      expiresIn: this.configService.getOrThrow<string>('jwt.expiration'),
      algorithm: 'HS256',
      issuer,
      audience,
    } as JwtSignOptions;

    const refreshOptions = {
      secret: this.configService.getOrThrow<string>('jwt.refreshSecret'),
      expiresIn: this.configService.getOrThrow<string>('jwt.refreshExpiration'),
      algorithm: 'HS256',
      issuer,
      audience,
    } as JwtSignOptions;

    // Access token — vida corta (15min por defecto) para limitar
    // la ventana de exposición si es interceptado
    const accessToken = await this.jwtService.signAsync(payload, accessOptions);

    // Refresh token — firmado con secreto DIFERENTE al access token
    // Así la compromisión del secret de access no compromete refresh
    // OWASP A02:2025 — separación de secretos por propósito
    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id },
      refreshOptions,
    );

    // Hasheamos el refresh token con Argon2id antes de persistirlo
    // Si la DB es comprometida, los refresh tokens no son usables
    const refreshTokenHash = await argon2.hash(refreshToken, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await this.userRepository.update(user.id, { refreshTokenHash });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }
}
