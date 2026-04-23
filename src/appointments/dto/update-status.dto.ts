// src/appointments/dto/update-status.dto.ts

import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AppointmentStatus } from '../entities/appointment.entity';

// DTO dedicado para el endpoint PATCH /appointments/:id/status
// Separar este DTO del UpdateAppointmentDto evita que el cliente
// pueda colar otros campos al cambiar solo el estado — el
// ValidationPipe con forbidNonWhitelisted rechaza cualquier
// propiedad extra automáticamente. OWASP A04: Insecure Design
export class UpdateStatusDto {

  @ApiProperty({
    enum: AppointmentStatus,
    example: AppointmentStatus.CONFIRMED,
  })
  @IsEnum(AppointmentStatus, {
    message: `El estado debe ser uno de: ${Object.values(AppointmentStatus).join(', ')}`,
  })
  @IsNotEmpty({ message: 'El estado es requerido' })
  status!: AppointmentStatus;
}
