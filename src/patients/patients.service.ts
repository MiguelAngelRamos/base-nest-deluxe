// src/patients/patients.service.ts

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Patient } from './entities/patient.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user.interface';

@Injectable()
export class PatientsService {
  constructor(
    @InjectRepository(Patient)
    private readonly patientRepository: Repository<Patient>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: IDOR (#4) — un paciente podía crear fichas
  //   para otro userId arbitrario o leer datos clínicos ajenos.
  // Mitigación: helper de autorización centralizado:
  //   - ADMIN y DOCTOR leen cualquier paciente (asistencia clínica).
  //   - PATIENT solo lee/modifica el paciente cuyo userId == su id.
  //   Write-access sigue la misma regla (con PATIENT acotado a self).
  // Justificación OWASP A01 Broken Access Control + A04:
  //   el recurso "paciente" requiere vincular identidad (req.user.id)
  //   con propiedad (patient.userId). Sin este check, el UUID en URL
  //   es una referencia directa sin control de acceso.
  // ─────────────────────────────────────────────
  private assertCanRead(user: AuthenticatedUser, patient: Patient): void {
    if (user.role === UserRole.ADMIN || user.role === UserRole.DOCTOR) return;
    if (patient.userId === user.id) return;
    throw new ForbiddenException(
      'No tienes permisos para acceder a este recurso',
    );
  }

  private assertCanWrite(user: AuthenticatedUser, patient: Patient): void {
    if (user.role === UserRole.ADMIN) return;
    if (user.role === UserRole.PATIENT && patient.userId === user.id) return;
    throw new ForbiddenException(
      'No tienes permisos para modificar este recurso',
    );
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: Privilege escalation lateral al crear pacientes (#4)
  // Mitigación: si el caller es PATIENT, se fuerza que el userId
  //   del DTO coincida con su propio id. ADMIN puede crear fichas
  //   para cualquier userId (flujo administrativo). DOCTOR no puede
  //   crear pacientes — no es su responsabilidad.
  // Justificación OWASP A01 + A04: evita que un paciente legítimo
  //   cree una ficha sobre otro userId para acceder a sus datos.
  // ─────────────────────────────────────────────
  async create(
    createPatientDto: CreatePatientDto,
    currentUser: AuthenticatedUser,
  ): Promise<Patient> {
    if (currentUser.role === UserRole.DOCTOR) {
      throw new ForbiddenException('Los médicos no pueden crear pacientes');
    }

    if (
      currentUser.role === UserRole.PATIENT &&
      createPatientDto.userId !== currentUser.id
    ) {
      throw new ForbiddenException(
        'Solo puedes crear tu propia ficha de paciente',
      );
    }

    const user = await this.userRepository.findOne({
      where: { id: createPatientDto.userId },
    });

    if (!user) {
      throw new NotFoundException(
        `Usuario con id ${createPatientDto.userId} no encontrado`,
      );
    }

    const existingPatient = await this.patientRepository.findOne({
      where: { userId: createPatientDto.userId },
    });

    if (existingPatient) {
      throw new ConflictException(
        `El usuario ${createPatientDto.userId} ya tiene un paciente asociado`,
      );
    }

    const patient = this.patientRepository.create({
      userId: createPatientDto.userId,
      firstName: createPatientDto.firstName,
      lastName: createPatientDto.lastName,
      birthDate: createPatientDto.birthDate
        ? new Date(createPatientDto.birthDate)
        : null,
      gender: createPatientDto.gender ?? null,
      phone: createPatientDto.phone ?? null,
      address: createPatientDto.address ?? null,
    });

    return this.patientRepository.save(patient);
  }

  async findAll(): Promise<Patient[]> {
    return this.patientRepository
      .createQueryBuilder('patient')
      .innerJoin('patient.user', 'user', 'user.isActive = :active', {
        active: true,
      })
      .getMany();
  }

  async findOne(id: string, currentUser: AuthenticatedUser): Promise<Patient> {
    const patient = await this.patientRepository
      .createQueryBuilder('patient')
      .innerJoin('patient.user', 'user', 'user.isActive = :active', {
        active: true,
      })
      .where('patient.id = :id', { id })
      .getOne();

    if (!patient) {
      throw new NotFoundException(`Paciente con id ${id} no encontrado`);
    }

    this.assertCanRead(currentUser, patient);
    return patient;
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: soft-delete inconsistente (#7) + IDOR (#4).
  // Mitigación:
  //   1) Query con inner join a user filtrando isActive=true para
  //      excluir pacientes cuyo usuario fue desactivado.
  //   2) Chequeo de ownership tras cargar el recurso.
  // Justificación OWASP A01 + A04: cerrar el hueco donde
  //   findByUserId omitía el filtro y exponía registros "eliminados".
  // ─────────────────────────────────────────────
  async findByUserId(
    userId: string,
    currentUser: AuthenticatedUser,
  ): Promise<Patient> {
    const patient = await this.patientRepository
      .createQueryBuilder('patient')
      .innerJoin('patient.user', 'user', 'user.isActive = :active', {
        active: true,
      })
      .where('patient.userId = :userId', { userId })
      .getOne();

    if (!patient) {
      throw new NotFoundException(
        `No se encontró paciente para el usuario ${userId}`,
      );
    }

    this.assertCanRead(currentUser, patient);
    return patient;
  }

  async update(
    id: string,
    updatePatientDto: UpdatePatientDto,
    currentUser: AuthenticatedUser,
  ): Promise<Patient> {
    const patient = await this.findOne(id, currentUser);
    this.assertCanWrite(currentUser, patient);

    if (updatePatientDto.userId && updatePatientDto.userId !== patient.userId) {
      throw new ConflictException(
        'No se puede cambiar el userId de un paciente existente',
      );
    }

    Object.assign(patient, {
      ...updatePatientDto,
      birthDate: updatePatientDto.birthDate
        ? new Date(updatePatientDto.birthDate)
        : patient.birthDate,
    });

    return this.patientRepository.save(patient);
  }

  async remove(id: string, currentUser: AuthenticatedUser): Promise<void> {
    const patient = await this.findOne(id, currentUser);
    // Desactivación de ficha = operación administrativa. assertCanWrite
    // admitiría al propio paciente, pero aquí elevamos a ADMIN para
    // evitar que un paciente se borre y deje huérfanas sus citas.
    if (currentUser.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Solo un administrador puede desactivar un paciente',
      );
    }

    await this.userRepository.update(patient.userId, { isActive: false });
  }
}
