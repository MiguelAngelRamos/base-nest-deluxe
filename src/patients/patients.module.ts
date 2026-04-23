// src/patients/patients.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { Patient } from './entities/patient.entity';
import { User } from '../users/entities/user.entity';

// forFeature registra Patient y User — PatientsService necesita
// ambos repositorios: Patient para el CRUD propio y User para
// verificar existencia del userId al crear y para soft delete
// Registrar User aquí no duplica la entidad — solo habilita
// la inyección del Repository<User> en este módulo
@Module({
  imports: [TypeOrmModule.forFeature([Patient, User])],
  controllers: [PatientsController],
  providers: [PatientsService],
  exports: [PatientsService],
})
export class PatientsModule {}
