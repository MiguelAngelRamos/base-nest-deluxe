// src/doctors/doctors.service.ts

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Doctor } from './entities/doctor.entity';
import { User } from '../users/entities/user.entity';
import { Specialty } from '../specialties/entities/specialty.entity';
import { CreateDoctorDto } from './dto/create-doctor.dto';
import { UpdateDoctorDto } from './dto/update-doctor.dto';

@Injectable()
export class DoctorsService {

  // Inyectamos tres repositorios: Doctor para el CRUD propio,
  // User para validar userId y soft delete, Specialty para
  // asignar/desasignar especialidades sin pasar por otro servicio
  constructor(
    @InjectRepository(Doctor)
    private readonly doctorRepository: Repository<Doctor>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Specialty)
    private readonly specialtyRepository: Repository<Specialty>,
  ) {}

  async create(createDoctorDto: CreateDoctorDto): Promise<Doctor> {

    // Verificamos que el userId referenciado exista
    const user = await this.userRepository.findOne({
      where: { id: createDoctorDto.userId },
    });

    if (!user) {
      throw new NotFoundException(
        `Usuario con id ${createDoctorDto.userId} no encontrado`,
      );
    }

    // Relación OneToOne — un usuario no puede tener dos fichas
    // de médico. Verificamos antes de insertar para devolver 409
    const existingDoctor = await this.doctorRepository.findOne({
      where: { userId: createDoctorDto.userId },
    });

    if (existingDoctor) {
      throw new ConflictException(
        `El usuario ${createDoctorDto.userId} ya tiene un médico asociado`,
      );
    }

    // licenseNumber debe ser único por médico — verificamos antes
    // de insertar para devolver 409 con mensaje claro en lugar
    // de un error de constraint unique de PostgreSQL
    const existingLicense = await this.doctorRepository.findOne({
      where: { licenseNumber: createDoctorDto.licenseNumber },
    });

    if (existingLicense) {
      throw new ConflictException(
        `El número de licencia ${createDoctorDto.licenseNumber} ya está registrado`,
      );
    }

    const doctor = this.doctorRepository.create({
      userId: createDoctorDto.userId,
      firstName: createDoctorDto.firstName,
      lastName: createDoctorDto.lastName,
      licenseNumber: createDoctorDto.licenseNumber,
      phone: createDoctorDto.phone ?? null,
    });

    return this.doctorRepository.save(doctor);
  }

  async findAll(): Promise<Doctor[]> {
    // relations: { specialties: true } — eager loading explícito
    // solo en este método. Las entidades tienen eager: false por
    // defecto para evitar queries innecesarias en otros contextos
    return this.doctorRepository
      .createQueryBuilder('doctor')
      .innerJoin('doctor.user', 'user', 'user.isActive = :active', {
        active: true,
      })
      .leftJoinAndSelect('doctor.specialties', 'specialty')
      .getMany();
  }

  async findOne(id: string): Promise<Doctor> {
    const doctor = await this.doctorRepository
      .createQueryBuilder('doctor')
      .innerJoin('doctor.user', 'user', 'user.isActive = :active', {
        active: true,
      })
      .leftJoinAndSelect('doctor.specialties', 'specialty')
      .where('doctor.id = :id', { id })
      .getOne();

    if (!doctor) {
      throw new NotFoundException(`Médico con id ${id} no encontrado`);
    }

    return doctor;
  }

  async findBySpecialty(specialtyId: string): Promise<Doctor[]> {
    // Verificamos primero que la especialidad exista —
    // así devolvemos 404 claro en lugar de lista vacía confusa
    const specialty = await this.specialtyRepository.findOne({
      where: { id: specialtyId },
    });

    if (!specialty) {
      throw new NotFoundException(
        `Especialidad con id ${specialtyId} no encontrada`,
      );
    }

    // Query builder para filtrar médicos por especialidad
    // JOIN con la tabla intermedia doctor_specialties
    // y cargar todas las especialidades del médico retornado
    return this.doctorRepository
      .createQueryBuilder('doctor')
      .innerJoin('doctor.user', 'user', 'user.isActive = :active', {
        active: true,
      })
      .innerJoin('doctor.specialties', 'filterSpecialty')
      .leftJoinAndSelect('doctor.specialties', 'specialty')
      .where('filterSpecialty.id = :specialtyId', { specialtyId })
      .getMany();
  }

  async update(
    id: string,
    updateDoctorDto: UpdateDoctorDto,
  ): Promise<Doctor> {
    const doctor = await this.findOne(id);

    if (updateDoctorDto.userId && updateDoctorDto.userId !== doctor.userId) {
      throw new ConflictException(
        'No se puede cambiar el userId de un médico existente',
      );
    }

    // Si viene un licenseNumber nuevo verificamos que no lo use
    // otro médico — misma estrategia que el email en UsersService
    if (
      updateDoctorDto.licenseNumber &&
      updateDoctorDto.licenseNumber !== doctor.licenseNumber
    ) {
      const existingLicense = await this.doctorRepository.findOne({
        where: { licenseNumber: updateDoctorDto.licenseNumber },
      });

      if (existingLicense) {
        throw new ConflictException(
          `El número de licencia ${updateDoctorDto.licenseNumber} ya está registrado`,
        );
      }
    }

    Object.assign(doctor, updateDoctorDto);
    return this.doctorRepository.save(doctor);
  }

  async addSpecialty(doctorId: string, specialtyId: string): Promise<Doctor> {
    const doctor = await this.findOne(doctorId);

    const specialty = await this.specialtyRepository.findOne({
      where: { id: specialtyId },
    });

    if (!specialty) {
      throw new NotFoundException(
        `Especialidad con id ${specialtyId} no encontrada`,
      );
    }

    // Verificamos si ya está asignada — la tabla intermedia tiene
    // PK compuesta (doctor_id, specialty_id) así que insertar
    // duplicados lanzaría error. Mejor devolver 409 claro
    const alreadyAssigned = doctor.specialties?.some(
      (s) => s.id === specialtyId,
    );

    if (alreadyAssigned) {
      throw new ConflictException(
        `La especialidad "${specialty.name}" ya está asignada al médico`,
      );
    }

    doctor.specialties = [...(doctor.specialties ?? []), specialty];
    return this.doctorRepository.save(doctor);
  }

  async removeSpecialty(
    doctorId: string,
    specialtyId: string,
  ): Promise<Doctor> {
    const doctor = await this.findOne(doctorId);

    const isAssigned = doctor.specialties?.some((s) => s.id === specialtyId);

    if (!isAssigned) {
      throw new NotFoundException(
        `La especialidad ${specialtyId} no está asignada a este médico`,
      );
    }

    // Filtramos la especialidad y guardamos — TypeORM detecta el
    // cambio en la relación ManyToMany y elimina la fila en la
    // tabla intermedia automáticamente
    doctor.specialties = doctor.specialties.filter(
      (s) => s.id !== specialtyId,
    );
    return this.doctorRepository.save(doctor);
  }

  async remove(id: string): Promise<void> {
    const doctor = await this.findOne(id);

    // Soft delete — desactivamos el usuario asociado. Mantiene
    // la integridad referencial con appointments e histórico de
    // citas atendidas por este médico
    await this.userRepository.update(doctor.userId, { isActive: false });
  }
}
