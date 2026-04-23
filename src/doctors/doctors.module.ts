// src/doctors/doctors.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';
import { Doctor } from './entities/doctor.entity';
import { User } from '../users/entities/user.entity';
import { Specialty } from '../specialties/entities/specialty.entity';

// Registramos Doctor, User y Specialty para que DoctorsService
// pueda inyectar los tres repositorios. Mantiene el servicio
// independiente de UsersService/SpecialtiesService — no hay
// dependencia circular y cada módulo es autosuficiente
@Module({
  imports: [TypeOrmModule.forFeature([Doctor, User, Specialty])],
  controllers: [DoctorsController],
  providers: [DoctorsService],
  exports: [DoctorsService],
})
export class DoctorsModule {}
