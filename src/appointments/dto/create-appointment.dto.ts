// src/appointments/dto/create-appointment.dto.ts

import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '../entities/appointment.entity';

export class CreateAppointmentDto {

  @ApiProperty({ example: 'f3a1b2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c' })
  @IsUUID('4', { message: 'El patientId debe ser un UUID válido' })
  @IsNotEmpty({ message: 'El patientId es requerido' })
  patientId!: string;

  @ApiProperty({ example: 'e2a1b2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5d' })
  @IsUUID('4', { message: 'El doctorId debe ser un UUID válido' })
  @IsNotEmpty({ message: 'El doctorId es requerido' })
  doctorId!: string;

  @ApiProperty({
    example: '2026-05-20',
    description: 'Fecha de la cita (YYYY-MM-DD)',
  })
  @IsDateString({}, { message: 'La fecha debe tener formato YYYY-MM-DD' })
  @IsNotEmpty({ message: 'La fecha es requerida' })
  date!: string;

  @ApiProperty({ example: '09:30', description: 'Hora inicio HH:MM (24h)' })
  @IsString()
  @IsNotEmpty({ message: 'La hora de inicio es requerida' })
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'La hora de inicio debe tener formato HH:MM (24 horas)',
  })
  startTime!: string;

  @ApiProperty({ example: '10:00', description: 'Hora fin HH:MM (24h)' })
  @IsString()
  @IsNotEmpty({ message: 'La hora de fin es requerida' })
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'La hora de fin debe tener formato HH:MM (24 horas)',
  })
  endTime!: string;

  @ApiPropertyOptional({
    enum: AppointmentStatus,
    example: AppointmentStatus.SCHEDULED,
  })
  @IsOptional()
  @IsEnum(AppointmentStatus, {
    message: `El estado debe ser uno de: ${Object.values(AppointmentStatus).join(', ')}`,
  })
  status?: AppointmentStatus;

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: notes sin límite de tamaño (#13)
  // Mitigación: @MaxLength(2000) — suficiente para una nota
  //   clínica breve; contenido extenso pertenece a otro recurso
  //   (historial, archivo adjunto). Previene DoS por almacenamiento
  //   y queries degradadas por filas excesivamente grandes.
  // Justificación OWASP A04 (abuse of functionality) y A05
  //   (misconfiguración de límites): validar tamaños en el borde
  //   es control estándar contra resource exhaustion.
  // ─────────────────────────────────────────────
  @ApiPropertyOptional({ example: 'Control anual de presión arterial' })
  @IsOptional()
  @IsString()
  @MaxLength(2000, {
    message: 'Las notas no pueden superar los 2000 caracteres',
  })
  notes?: string;
}
