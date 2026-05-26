// src/doctors/doctors.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DoctorsService } from './doctors.service';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

// ─────────────────────────────────────────────
// [SECURE-FIX] A04 - Insecure Design
// Vulnerabilidad: Sin RBAC en Doctors (#3) — un paciente podía
//   crear/borrar médicos y asignarles especialidades.
// Mitigación: lectura libre para cualquier autenticado (directorio
//   clínico); escritura + gestión de especialidades solo ADMIN.
// Justificación OWASP A01 + A04: mismo principio que Specialties;
//   directorio es público a usuarios del sistema, su mutación es
//   tarea administrativa.
// ─────────────────────────────────────────────
@ApiTags('doctors')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear médico (solo ADMIN)' })
  @ApiResponse({ status: 201, description: 'Médico creado' })
  @ApiResponse({ status: 403, description: 'Requiere rol ADMIN' })
  create(@Body() createDoctorDto: CreateDoctorDto) {
    return this.doctorsService.create(createDoctorDto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar médicos' })
  findAll() {
    return this.doctorsService.findAll();
  }

  @Get('specialty/:specialtyId')
  @ApiOperation({ summary: 'Médicos por especialidad' })
  findBySpecialty(@Param('specialtyId', ParseUUIDPipe) specialtyId: string) {
    return this.doctorsService.findBySpecialty(specialtyId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener médico por id' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctorsService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Actualizar médico (solo ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDoctorDto: UpdateDoctorDto,
  ) {
    return this.doctorsService.update(id, updateDoctorDto);
  }

  @Post(':id/specialties/:specialtyId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Asignar especialidad (solo ADMIN)' })
  addSpecialty(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('specialtyId', ParseUUIDPipe) specialtyId: string,
  ) {
    return this.doctorsService.addSpecialty(id, specialtyId);
  }

  @Delete(':id/specialties/:specialtyId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desasignar especialidad (solo ADMIN)' })
  removeSpecialty(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('specialtyId', ParseUUIDPipe) specialtyId: string,
  ) {
    return this.doctorsService.removeSpecialty(id, specialtyId);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desactivar médico (solo ADMIN)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctorsService.remove(id);
  }
}
