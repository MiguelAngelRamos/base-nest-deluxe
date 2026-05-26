// src/patients/dto/update-patient.dto.ts

import { PartialType } from '@nestjs/swagger';
import { CreatePatientDto } from './create-patient.dto';

// Todos los campos de CreatePatientDto se vuelven opcionales
// Las validaciones se mantienen para los campos que se envíen
export class UpdatePatientDto extends PartialType(CreatePatientDto) {}
