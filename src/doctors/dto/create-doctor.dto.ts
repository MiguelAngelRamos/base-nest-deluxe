// src/doctors/dto/create-doctor.dto.ts

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDoctorDto {

  @ApiProperty({
    example: 'f3a1b2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c',
    description: 'UUID del usuario asociado (debe existir en users)',
  })
  @IsUUID('4', { message: 'El userId debe ser un UUID válido' })
  @IsNotEmpty({ message: 'El userId es requerido' })
  userId!: string;

  @ApiProperty({ example: 'María' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @Length(2, 100, { message: 'El nombre debe tener entre 2 y 100 caracteres' })
  firstName!: string;

  @ApiProperty({ example: 'Pérez' })
  @IsString()
  @IsNotEmpty({ message: 'El apellido es requerido' })
  @Length(2, 100, { message: 'El apellido debe tener entre 2 y 100 caracteres' })
  lastName!: string;

  @ApiProperty({
    example: 'MED-12345-CL',
    description: 'Número único de licencia médica',
  })
  @IsString()
  @IsNotEmpty({ message: 'El número de licencia es requerido' })
  @Length(5, 50, {
    message: 'El número de licencia debe tener entre 5 y 50 caracteres',
  })
  licenseNumber!: string;

  @ApiPropertyOptional({ example: '+56987654321' })
  @IsOptional()
  @IsString()
  @Matches(/^(\+?56)?[2-9]\d{8}$/, {
    message: 'El teléfono debe tener un formato válido',
  })
  phone?: string;
}
