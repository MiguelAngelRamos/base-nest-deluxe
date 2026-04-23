// src/appointments/appointments.controller.ts

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
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../users/entities/user.entity';
import type { AuthenticatedUser } from '../common/types/authenticated-user.interface';


@ApiTags('appointments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('appointments')
export class AppointmentsController {

  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear cita (paciente/doctor: solo la propia)' })
  create(
    @Body() createAppointmentDto: CreateAppointmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.create(createAppointmentDto, user);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Listar todas las citas (solo ADMIN)' })
  findAll() {
    return this.appointmentsService.findAll();
  }

  @Get('patient/:patientId')
  @ApiOperation({ summary: 'Citas de un paciente (ownership)' })
  findByPatient(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.findByPatient(patientId, user);
  }

  @Get('doctor/:doctorId')
  @ApiOperation({ summary: 'Citas de un médico (ADMIN o el propio)' })
  findByDoctor(
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.findByDoctor(doctorId, user);
  }

  @Get('date/:date')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Citas de una fecha (solo ADMIN)' })
  findByDate(@Param('date') date: string) {
    return this.appointmentsService.findByDate(date);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener cita por id (ownership)' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.findOne(id, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Actualizar estado (ownership)' })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateStatusDto: UpdateStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.updateStatus(
      id,
      updateStatusDto.status,
      user,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar cita (ownership)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateAppointmentDto: UpdateAppointmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.update(id, updateAppointmentDto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancelar cita (soft-delete, ownership)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.appointmentsService.remove(id, user);
  }
}
