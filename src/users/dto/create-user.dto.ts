// src/users/dto/create-user.dto.ts

import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../entities/user.entity';

export class CreateUserDto {

  @ApiProperty({
    example: 'juan.gonzalez@clinica.cl',
    description: 'Email único del usuario en formato válido',
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
  //* [SECURE-FIX V10] Regex con ancla final — ver explicación en
  //* src/auth/dto/register.dto.ts.
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    {
      message:
        'La contraseña debe contener al menos una mayúscula, ' +
        'una minúscula, un número y un carácter especial',
    },
  )
  password!: string;

  @ApiProperty({
    enum: UserRole,
    example: UserRole.PATIENT,
    description: 'Rol del usuario en el sistema',
  })
  @IsEnum(UserRole, {
    message: `El rol debe ser uno de: ${Object.values(UserRole).join(', ')}`,
  })
  role!: UserRole;
}
