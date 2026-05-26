// src/auth/dto/register.dto.ts

import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Privilege escalation en /auth/register (#1)
// Mitigación: RegisterDto deja de extender CreateUserDto —
//   ahora declara solo email y password. El cliente no puede
//   elegir su rol. El rol lo asigna AuthService.register en servidor.
// Justificación OWASP A01 Broken Access Control + A04:
//   el DTO es el contrato del límite de confianza. Al omitir
//   `role`, cualquier tentativa de enviar "role":"admin" desde
//   fuera es eliminada por el ValidationPipe (whitelist:true)
//   y si se configura forbidNonWhitelisted rechaza la petición.
// ─────────────────────────────────────────────
export class RegisterDto {
  @ApiProperty({
    example: 'juan.gonzalez@clinica.cl',
    description: 'Email único del usuario',
  })
  @IsEmail({}, { message: 'El email debe tener un formato válido' })
  @IsNotEmpty({ message: 'El email es requerido' })
  email!: string;

  @ApiProperty({
    example: 'Abcdef1!',
    description:
      'Contraseña con mínimo 8 caracteres, al menos una mayúscula, ' +
      'una minúscula, un número y un carácter especial',
    minLength: 8,
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener mínimo 8 caracteres' })
  //* [SECURE-FIX V10] Regex con ancla final {8,}$ — antes solo se
  //* validaba el primer carácter contra la lista permitida, el resto
  //* podía ser cualquier cosa. Ahora el regex obliga a que TODA la
  //* contraseña use el conjunto [A-Za-z\d@$!%*?&] y mantenga la
  //* longitud mínima de 8. El mensaje ahora coincide con lo validado.
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    {
      message:
        'La contraseña debe contener al menos una mayúscula, ' +
        'una minúscula, un número y un carácter especial',
    },
  )
  password!: string;
}
