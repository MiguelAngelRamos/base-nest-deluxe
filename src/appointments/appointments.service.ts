// src/appointments/appointments.service.ts

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Appointment,
  AppointmentStatus,
} from './entities/appointment.entity';
import { Patient } from '../patients/entities/patient.entity';
import { Doctor } from '../doctors/entities/doctor.entity';
import { UserRole } from '../users/entities/user.entity';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user.interface';

@Injectable()
export class AppointmentsService {

  constructor(
    @InjectRepository(Appointment)
    private readonly appointmentRepository: Repository<Appointment>,
    @InjectRepository(Patient)
    private readonly patientRepository: Repository<Patient>,
    @InjectRepository(Doctor)
    private readonly doctorRepository: Repository<Doctor>,
  ) {}

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: IDOR en appointments (#4)
  // Mitigación: helpers de autorización — solo las partes
  //   involucradas (paciente, médico) o un ADMIN pueden leer
  //   o modificar una cita específica.
  // Justificación OWASP A01 + A04: una cita médica contiene
  //   datos clínicos sensibles; terceros no deben acceder ni
  //   modificar agendas ajenas.
  // ─────────────────────────────────────────────
  private async assertCanAccess(
    user: AuthenticatedUser,
    appointment: Appointment,
  ): Promise<void> {
    if (user.role === UserRole.ADMIN) return;

    if (user.role === UserRole.PATIENT) {
      const patient = await this.patientRepository.findOne({
        where: { userId: user.id },
      });
      if (patient && patient.id === appointment.patientId) return;
    }

    if (user.role === UserRole.DOCTOR) {
      const doctor = await this.doctorRepository.findOne({
        where: { userId: user.id },
      });
      if (doctor && doctor.id === appointment.doctorId) return;
    }

    throw new ForbiddenException(
      'No tienes permisos para acceder a esta cita',
    );
  }

  private async resolvePatientIdForUser(
    user: AuthenticatedUser,
  ): Promise<string | null> {
    if (user.role !== UserRole.PATIENT) return null;
    const patient = await this.patientRepository.findOne({
      where: { userId: user.id },
    });
    return patient?.id ?? null;
  }

  private async resolveDoctorIdForUser(
    user: AuthenticatedUser,
  ): Promise<string | null> {
    if (user.role !== UserRole.DOCTOR) return null;
    const doctor = await this.doctorRepository.findOne({
      where: { userId: user.id },
    });
    return doctor?.id ?? null;
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: IDOR al crear citas (#4) + conflicto de
  //   horario solo por doctor (#8)
  // Mitigación:
  //   1) PATIENT solo puede crear citas con su propio patientId;
  //      DOCTOR solo como el propio doctorId; ADMIN puede ambos.
  //   2) Se valida conflicto de agenda TANTO para el médico
  //      como para el paciente — dos citas simultáneas del mismo
  //      paciente con médicos distintos ya no son posibles.
  // Justificación OWASP A01 + A04: las reglas de negocio de
  //   agenda clínica deben ser consistentes con la identidad del
  //   solicitante y deben impedir double-booking en ambas caras
  //   de la relación.
  // ─────────────────────────────────────────────
  async create(
    createAppointmentDto: CreateAppointmentDto,
    currentUser: AuthenticatedUser,
  ): Promise<Appointment> {

    if (createAppointmentDto.endTime <= createAppointmentDto.startTime) {
      throw new BadRequestException(
        'La hora de fin debe ser posterior a la hora de inicio',
      );
    }

    if (currentUser.role === UserRole.PATIENT) {
      const ownPatientId = await this.resolvePatientIdForUser(currentUser);
      if (!ownPatientId || ownPatientId !== createAppointmentDto.patientId) {
        throw new ForbiddenException(
          'Solo puedes crear citas para ti mismo',
        );
      }
    }

    if (currentUser.role === UserRole.DOCTOR) {
      const ownDoctorId = await this.resolveDoctorIdForUser(currentUser);
      if (!ownDoctorId || ownDoctorId !== createAppointmentDto.doctorId) {
        throw new ForbiddenException(
          'Los médicos solo pueden crear citas en las que participen',
        );
      }
    }

    const patient = await this.patientRepository.findOne({
      where: { id: createAppointmentDto.patientId },
    });

    if (!patient) {
      throw new NotFoundException(
        `Paciente con id ${createAppointmentDto.patientId} no encontrado`,
      );
    }

    const doctor = await this.doctorRepository.findOne({
      where: { id: createAppointmentDto.doctorId },
    });

    if (!doctor) {
      throw new NotFoundException(
        `Médico con id ${createAppointmentDto.doctorId} no encontrado`,
      );
    }

    await this.assertNoScheduleConflict(
      createAppointmentDto.doctorId,
      createAppointmentDto.patientId,
      createAppointmentDto.date,
      createAppointmentDto.startTime,
      createAppointmentDto.endTime,
      null,
    );

    const appointment = this.appointmentRepository.create({
      patientId: createAppointmentDto.patientId,
      doctorId: createAppointmentDto.doctorId,
      date: new Date(createAppointmentDto.date),
      startTime: createAppointmentDto.startTime,
      endTime: createAppointmentDto.endTime,
      status: createAppointmentDto.status ?? AppointmentStatus.SCHEDULED,
      notes: createAppointmentDto.notes ?? null,
    });

    return this.appointmentRepository.save(appointment);
  }

  // Helper único de detección de conflicto para doctor y paciente.
  // excludeId permite excluir la propia cita al hacer update.
  private async assertNoScheduleConflict(
    doctorId: string,
    patientId: string,
    date: string | Date,
    startTime: string,
    endTime: string,
    excludeId: string | null,
  ): Promise<void> {
    const baseQuery = () =>
      this.appointmentRepository
        .createQueryBuilder('appointment')
        .where('appointment.date = :date', { date })
        .andWhere('appointment.status != :cancelled', {
          cancelled: AppointmentStatus.CANCELLED,
        })
        .andWhere('appointment.startTime < :endTime', { endTime })
        .andWhere('appointment.endTime > :startTime', { startTime });

    const doctorQb = baseQuery().andWhere(
      'appointment.doctorId = :doctorId',
      { doctorId },
    );
    if (excludeId) {
      doctorQb.andWhere('appointment.id != :excludeId', { excludeId });
    }
    const doctorConflict = await doctorQb.getOne();
    if (doctorConflict) {
      throw new ConflictException(
        `El médico ya tiene una cita programada que se solapa ` +
          `(${doctorConflict.startTime} - ${doctorConflict.endTime})`,
      );
    }

    const patientQb = baseQuery().andWhere(
      'appointment.patientId = :patientId',
      { patientId },
    );
    if (excludeId) {
      patientQb.andWhere('appointment.id != :excludeId', { excludeId });
    }
    const patientConflict = await patientQb.getOne();
    if (patientConflict) {
      throw new ConflictException(
        `El paciente ya tiene una cita programada que se solapa ` +
          `(${patientConflict.startTime} - ${patientConflict.endTime})`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: findAll sin RBAC (#3) + soft-delete inconsistente (#7)
  // Mitigación: findAll restringido a ADMIN vía controller (@Roles).
  //   Se excluyen citas cuyo paciente o médico estén desactivados
  //   (user.isActive = false) mediante inner join.
  // Justificación OWASP A01 + A04: listados completos son operación
  //   administrativa; filas asociadas a usuarios desactivados no deben
  //   filtrarse al cliente.
  // ─────────────────────────────────────────────
  async findAll(): Promise<Appointment[]> {
    return this.appointmentRepository
      .createQueryBuilder('appointment')
      .innerJoinAndSelect('appointment.patient', 'patient')
      .innerJoinAndSelect('patient.user', 'patientUser', 'patientUser.isActive = true')
      .innerJoinAndSelect('appointment.doctor', 'doctor')
      .innerJoinAndSelect('doctor.user', 'doctorUser', 'doctorUser.isActive = true')
      .orderBy('appointment.date', 'ASC')
      .addOrderBy('appointment.startTime', 'ASC')
      .getMany();
  }

  async findOne(
    id: string,
    currentUser: AuthenticatedUser,
  ): Promise<Appointment> {
    const appointment = await this.appointmentRepository.findOne({
      where: { id },
      relations: { patient: true, doctor: true },
    });

    if (!appointment) {
      throw new NotFoundException(`Cita con id ${id} no encontrada`);
    }

    await this.assertCanAccess(currentUser, appointment);
    return appointment;
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: IDOR (#4) + soft-delete inconsistente (#7)
  // Mitigación:
  //   - PATIENT solo obtiene citas si patientId coincide con el suyo.
  //   - DOCTOR puede consultar citas de cualquier paciente (necesario
  //     para atender), pero se limita a citas donde ÉL es el doctor.
  //   - ADMIN sin restricción.
  //   - Join filtra por user.isActive para excluir registros "eliminados".
  // Justificación OWASP A01 + A04: parametrizar un UUID en URL no da
  //   acceso por sí mismo — hay que autorizar explícitamente.
  // ─────────────────────────────────────────────
  async findByPatient(
    patientId: string,
    currentUser: AuthenticatedUser,
  ): Promise<Appointment[]> {
    const patient = await this.patientRepository.findOne({
      where: { id: patientId },
    });
    if (!patient) {
      throw new NotFoundException(
        `Paciente con id ${patientId} no encontrado`,
      );
    }

    if (currentUser.role === UserRole.PATIENT) {
      const ownPatientId = await this.resolvePatientIdForUser(currentUser);
      if (!ownPatientId || ownPatientId !== patientId) {
        throw new ForbiddenException(
          'Solo puedes consultar tus propias citas',
        );
      }
    }

    const qb = this.appointmentRepository
      .createQueryBuilder('appointment')
      .innerJoinAndSelect('appointment.doctor', 'doctor')
      .innerJoin('doctor.user', 'doctorUser', 'doctorUser.isActive = true')
      .where('appointment.patientId = :patientId', { patientId });

    if (currentUser.role === UserRole.DOCTOR) {
      const ownDoctorId = await this.resolveDoctorIdForUser(currentUser);
      if (!ownDoctorId) {
        throw new ForbiddenException('Médico sin registro profesional');
      }
      qb.andWhere('appointment.doctorId = :doctorId', {
        doctorId: ownDoctorId,
      });
    }

    return qb
      .orderBy('appointment.date', 'DESC')
      .addOrderBy('appointment.startTime', 'DESC')
      .getMany();
  }

  async findByDoctor(
    doctorId: string,
    currentUser: AuthenticatedUser,
  ): Promise<Appointment[]> {
    const doctor = await this.doctorRepository.findOne({
      where: { id: doctorId },
    });
    if (!doctor) {
      throw new NotFoundException(`Médico con id ${doctorId} no encontrado`);
    }

    // ─────────────────────────────────────────────
    // [SECURE-FIX] A04 - Insecure Design
    // Vulnerabilidad: IDOR en /appointments/doctor/:id (#4)
    // Mitigación: DOCTOR solo puede consultar sus propias citas;
    //   PATIENT no tiene acceso directo a las agendas por médico
    //   (obtendría información sobre otros pacientes).
    // Justificación OWASP A01 + A04: las agendas por médico son
    //   información gerencial/propia, no consumible por pacientes.
    // ─────────────────────────────────────────────
    if (currentUser.role === UserRole.DOCTOR) {
      const ownDoctorId = await this.resolveDoctorIdForUser(currentUser);
      if (!ownDoctorId || ownDoctorId !== doctorId) {
        throw new ForbiddenException(
          'Solo puedes consultar tu propia agenda',
        );
      }
    } else if (currentUser.role === UserRole.PATIENT) {
      throw new ForbiddenException(
        'Los pacientes no pueden listar las citas de un médico',
      );
    }

    return this.appointmentRepository
      .createQueryBuilder('appointment')
      .innerJoinAndSelect('appointment.patient', 'patient')
      .innerJoin('patient.user', 'patientUser', 'patientUser.isActive = true')
      .where('appointment.doctorId = :doctorId', { doctorId })
      .orderBy('appointment.date', 'ASC')
      .addOrderBy('appointment.startTime', 'ASC')
      .getMany();
  }

  async findByDate(date: string): Promise<Appointment[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException(
        'La fecha debe tener formato YYYY-MM-DD',
      );
    }

    // ─────────────────────────────────────────────
    // [SECURE-FIX] A04 - Insecure Design
    // Vulnerabilidad: soft-delete inconsistente (#7)
    // Mitigación: filtro por user.isActive vía inner join.
    //   El acceso ya se limita a ADMIN por @Roles en el controller.
    // ─────────────────────────────────────────────
    return this.appointmentRepository
      .createQueryBuilder('appointment')
      .innerJoinAndSelect('appointment.patient', 'patient')
      .innerJoin('patient.user', 'patientUser', 'patientUser.isActive = true')
      .innerJoinAndSelect('appointment.doctor', 'doctor')
      .innerJoin('doctor.user', 'doctorUser', 'doctorUser.isActive = true')
      .where('appointment.date = :date', { date })
      .orderBy('appointment.startTime', 'ASC')
      .getMany();
  }

  async updateStatus(
    id: string,
    status: AppointmentStatus,
    currentUser: AuthenticatedUser,
  ): Promise<Appointment> {
    const appointment = await this.findOne(id, currentUser);

    const finalStates: AppointmentStatus[] = [
      AppointmentStatus.COMPLETED,
      AppointmentStatus.NO_SHOW,
    ];

    if (
      finalStates.includes(appointment.status) &&
      appointment.status !== status
    ) {
      throw new ConflictException(
        `La cita en estado "${appointment.status}" no puede cambiar de estado`,
      );
    }

    appointment.status = status;
    return this.appointmentRepository.save(appointment);
  }

  async update(
    id: string,
    updateAppointmentDto: UpdateAppointmentDto,
    currentUser: AuthenticatedUser,
  ): Promise<Appointment> {
    const appointment = await this.findOne(id, currentUser);

    const newDate = updateAppointmentDto.date
      ? new Date(updateAppointmentDto.date)
      : appointment.date;
    const newStart = updateAppointmentDto.startTime ?? appointment.startTime;
    const newEnd = updateAppointmentDto.endTime ?? appointment.endTime;
    const newDoctorId = updateAppointmentDto.doctorId ?? appointment.doctorId;
    const newPatientId = updateAppointmentDto.patientId ?? appointment.patientId;

    if (newEnd <= newStart) {
      throw new BadRequestException(
        'La hora de fin debe ser posterior a la hora de inicio',
      );
    }

    if (
      updateAppointmentDto.date ||
      updateAppointmentDto.startTime ||
      updateAppointmentDto.endTime ||
      updateAppointmentDto.doctorId ||
      updateAppointmentDto.patientId
    ) {
      await this.assertNoScheduleConflict(
        newDoctorId,
        newPatientId,
        newDate as unknown as string,
        newStart,
        newEnd,
        id,
      );
    }

    Object.assign(appointment, {
      ...updateAppointmentDto,
      date: newDate,
    });

    return this.appointmentRepository.save(appointment);
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: hard delete sin auditoría (#10 — mitigación parcial)
  // Mitigación: DELETE /appointments/:id ya no elimina físicamente.
  //   Se reutiliza el status CANCELLED existente, preservando el
  //   registro para trazabilidad. La auditoría completa (quién canceló,
  //   cuándo, por qué) requiere una tabla audit_log pendiente —
  //   señalada como cambio estructural mayor en el review.
  // Justificación OWASP A09 Security Logging + A04: conservar el
  //   recurso permite reconstruir el historial incluso sin una tabla
  //   de auditoría dedicada.
  // ─────────────────────────────────────────────
  async remove(id: string, currentUser: AuthenticatedUser): Promise<void> {
    const appointment = await this.findOne(id, currentUser);

    if (appointment.status === AppointmentStatus.CANCELLED) {
      // Ya está cancelada — no es error idempotente ni destructivo
      return;
    }

    if (appointment.status === AppointmentStatus.COMPLETED) {
      throw new ConflictException(
        'No se puede cancelar una cita ya completada',
      );
    }

    appointment.status = AppointmentStatus.CANCELLED;
    await this.appointmentRepository.save(appointment);
  }
}
