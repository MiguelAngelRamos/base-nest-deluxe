// src/patients/dto/create-patient.dto.ts

import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '../entities/patient.entity';

export class CreatePatientDto {

  @ApiProperty({
    example: 'f3a1b2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c',
    description: 'UUID del usuario asociado (debe existir en users)',
  })
  @IsUUID('4', { message: 'El userId debe ser un UUID válido' })
  @IsNotEmpty({ message: 'El userId es requerido' })
  userId!: string;

  @ApiProperty({ example: 'Juan', description: 'Nombre del paciente' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre es requerido' })
  @Length(2, 100, { message: 'El nombre debe tener entre 2 y 100 caracteres' })
  firstName!: string;

  @ApiProperty({ example: 'González', description: 'Apellido del paciente' })
  @IsString()
  @IsNotEmpty({ message: 'El apellido es requerido' })
  @Length(2, 100, { message: 'El apellido debe tener entre 2 y 100 caracteres' })
  lastName!: string;

  @ApiPropertyOptional({
    example: '1990-05-15',
    description: 'Fecha de nacimiento en formato YYYY-MM-DD',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha debe tener formato YYYY-MM-DD' })
  birthDate?: string;

  @ApiPropertyOptional({ enum: Gender, example: Gender.MALE })
  @IsOptional()
  @IsEnum(Gender, {
    message: `El género debe ser uno de: ${Object.values(Gender).join(', ')}`,
  })
  gender?: Gender;

  @ApiPropertyOptional({
    example: '+56912345678',
    description: 'Teléfono chileno con o sin prefijo +56',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(\+?56)?[2-9]\d{8}$/, {
    message: 'El teléfono debe tener un formato válido',
  })
  phone?: string;

  @ApiPropertyOptional({ example: 'Av. Siempre Viva 742, Santiago' })
  @IsOptional()
  @IsString()
  @Length(0, 255, { message: 'La dirección no puede superar 255 caracteres' })
  address?: string;
}
