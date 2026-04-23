// src/specialties/specialties.service.ts

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Specialty } from './entities/specialty.entity';
import { CreateSpecialtyDto } from './dto/create-specialty.dto';
import { UpdateSpecialtyDto } from './dto/update-specialty.dto';

@Injectable()
export class SpecialtiesService {

  constructor(
    @InjectRepository(Specialty)
    private readonly specialtyRepository: Repository<Specialty>,
  ) {}

  async create(createSpecialtyDto: CreateSpecialtyDto): Promise<Specialty> {

    // El nombre de la especialidad es único — verificamos antes
    // de insertar para devolver 409 con mensaje claro, en lugar
    // de un error genérico de constraint unique de PostgreSQL
    const existing = await this.specialtyRepository.findOne({
      where: { name: createSpecialtyDto.name },
    });

    if (existing) {
      throw new ConflictException(
        `La especialidad "${createSpecialtyDto.name}" ya existe`,
      );
    }

    const specialty = this.specialtyRepository.create({
      name: createSpecialtyDto.name,
      description: createSpecialtyDto.description ?? null,
    });

    return this.specialtyRepository.save(specialty);
  }

  async findAll(): Promise<Specialty[]> {
    // Ordenamos por nombre para mostrar la lista alfabéticamente
    // en la UI — mejora la experiencia sin costo de rendimiento
    // porque ya existe índice implícito por constraint unique
    return this.specialtyRepository.find({
      order: { name: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Specialty> {
    const specialty = await this.specialtyRepository.findOne({
      where: { id },
    });

    if (!specialty) {
      throw new NotFoundException(`Especialidad con id ${id} no encontrada`);
    }

    return specialty;
  }

  async update(
    id: string,
    updateSpecialtyDto: UpdateSpecialtyDto,
  ): Promise<Specialty> {
    const specialty = await this.findOne(id);

    // Si viene un nombre nuevo verificamos que no esté en uso
    // por otra especialidad — mismo patrón que UsersService.update
    if (
      updateSpecialtyDto.name &&
      updateSpecialtyDto.name !== specialty.name
    ) {
      const existing = await this.specialtyRepository.findOne({
        where: { name: updateSpecialtyDto.name },
      });

      if (existing) {
        throw new ConflictException(
          `La especialidad "${updateSpecialtyDto.name}" ya existe`,
        );
      }
    }

    Object.assign(specialty, updateSpecialtyDto);
    return this.specialtyRepository.save(specialty);
  }

  async remove(id: string): Promise<void> {
    // Cargamos la especialidad con sus doctores para verificar
    // que no tenga médicos asignados — eliminar una especialidad
    // en uso rompería la relación ManyToMany silenciosamente
    const specialty = await this.specialtyRepository.findOne({
      where: { id },
      relations: { doctors: true },
    });

    if (!specialty) {
      throw new NotFoundException(`Especialidad con id ${id} no encontrada`);
    }

    if (specialty.doctors && specialty.doctors.length > 0) {
      // 409 Conflict es semánticamente correcto — el recurso
      // existe pero su estado actual impide la operación.
      // El cliente debe desasignar los médicos primero
      throw new ConflictException(
        `No se puede eliminar la especialidad — ` +
        `tiene ${specialty.doctors.length} médico(s) asignado(s)`,
      );
    }

    // Hard delete — a diferencia de users/patients/doctors las
    // especialidades no almacenan datos históricos sensibles y
    // pueden eliminarse físicamente si no están en uso
    await this.specialtyRepository.remove(specialty);
  }
}
