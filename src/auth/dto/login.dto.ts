// src/auth/dto/login.dto.ts

import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// DTO de login — solo valida formato básico. La comprobación
// de credenciales se hace en AuthService. OWASP A07:2021 —
// no damos pistas sobre la política de contraseñas aquí para
// no revelar a atacantes qué validaciones internas aplicamos
export class LoginDto {

  @ApiProperty({
    example: 'juan.gonzalez@clinica.cl',
    description: 'Email registrado del usuario',
  })
  @IsEmail({}, { message: 'El email debe tener un formato válido' })
  @IsNotEmpty({ message: 'El email es requerido' })
  email!: string;

  @ApiProperty({
    example: 'Abcdef1!',
    description: 'Contraseña del usuario',
  })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña es requerida' })
  password!: string;
}
