// src/specialties/dto/create-specialty.dto.ts

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSpecialtyDto {

  @ApiProperty({
    example: 'Cardiología',
    description: 'Nombre único de la especialidad médica',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la especialidad es requerido' })
  @Length(2, 100, {
    message: 'El nombre debe tener entre 2 y 100 caracteres',
  })
  name!: string;

  @ApiPropertyOptional({
    example: 'Diagnóstico y tratamiento de enfermedades del corazón',
  })
  @IsOptional()
  @IsString()
  @Length(0, 255, {
    message: 'La descripción no puede superar 255 caracteres',
  })
  description?: string;
}
