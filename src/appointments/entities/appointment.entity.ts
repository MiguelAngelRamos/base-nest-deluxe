// src/appointments/entities/appointment.entity.ts

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Patient } from '../../patients/entities/patient.entity';
import { Doctor } from '../../doctors/entities/doctor.entity';

// El enum define los estados posibles de una cita
// Refleja el ciclo de vida real de una cita médica
export enum AppointmentStatus {
  SCHEDULED = 'scheduled',   // agendada — estado inicial
  CONFIRMED = 'confirmed',   // confirmada por el médico
  CANCELLED = 'cancelled',   // cancelada por paciente o médico
  COMPLETED = 'completed',   // atención finalizada
  NO_SHOW = 'no_show',       // paciente no se presentó
}

@Entity('appointments')
export class Appointment {

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // @ManyToOne — muchas citas pertenecen a un paciente
  // Una cita siempre tiene exactamente un paciente
  // nullable: false es el valor por defecto pero lo declaramos
  // explícitamente para dejar clara la intención de diseño
  @ManyToOne(() => Patient, (patient) => patient.appointments, {
    eager: false,
    nullable: false,
  })
  @JoinColumn({ name: 'patient_id' })
  patient!: Patient;

  @Column({ name: 'patient_id' })
  patientId!: string;

  // @ManyToOne — muchas citas pertenecen a un médico
  // Una cita siempre tiene exactamente un médico
  @ManyToOne(() => Doctor, (doctor) => doctor.appointments, {
    eager: false,
    nullable: false,
  })
  @JoinColumn({ name: 'doctor_id' })
  doctor!: Doctor;

  @Column({ name: 'doctor_id' })
  doctorId!: string;

  // La fecha de la cita sin hora — permite agrupar citas por día
  // Separar date de start_time y end_time cumple 1FN
  // cada columna tiene un solo valor atómico
  @Column({ type: 'date' })
  date!: Date;

  // Hora de inicio de la cita
  // type: 'time' en PostgreSQL almacena solo la hora HH:MM:SS
  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  // Hora de fin — permite calcular la duración de la cita
  // y detectar conflictos de horario en el servicio
  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  @Column({
    type: 'enum',
    enum: AppointmentStatus,
    default: AppointmentStatus.SCHEDULED,
  })
  status!: AppointmentStatus;

  // Notas clínicas opcionales del médico sobre la cita
  // type: 'text' permite contenido largo sin límite de caracteres
  // a diferencia de varchar que tiene límite máximo
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}