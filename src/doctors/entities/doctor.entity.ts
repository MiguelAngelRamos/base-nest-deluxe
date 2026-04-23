// src/doctors/entities/doctor.entity.ts

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Specialty } from '../../specialties/entities/specialty.entity';
import type { Appointment } from '../../appointments/entities/appointment.entity';

@Entity('doctors')
export class Doctor {

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Igual que Patient — un médico tiene exactamente un usuario
  // La autenticación vive en users, los datos profesionales aquí
  // Esto cumple 3FN — ningún atributo depende de otro no clave
  @OneToOne(() => User, { eager: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ name: 'first_name', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', length: 100 })
  lastName!: string;

  // Número de licencia médica — único por médico
  // unique: true lo garantiza a nivel de base de datos
  @Column({ name: 'license_number', unique: true, length: 50 })
  licenseNumber!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string | null;

  // @ManyToMany con @JoinTable — este es el lado propietario
  // Solo uno de los dos lados debe tener @JoinTable
  // El lado con @JoinTable es quien controla la tabla intermedia
  // TypeORM creará la tabla doctor_specialties automáticamente
  // con las columnas doctor_id y specialty_id
  @ManyToMany(() => Specialty, (specialty) => specialty.doctors, {
    eager: false,
  })
  @JoinTable({
    name: 'doctor_specialties',
    joinColumn: {
      name: 'doctor_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'specialty_id',
      referencedColumnName: 'id',
    },
  })
  specialties!: Specialty[];

  // @OneToMany — un médico puede tener muchas citas
  // El segundo argumento define el lado inverso de la relación
  // appointment.doctor apunta de vuelta a este Doctor
  // OneToMany nunca tiene la llave foránea — la tiene el lado Many
  // La llave foránea doctor_id vive en la tabla appointments
  @OneToMany('Appointment', (appointment: Appointment) => appointment.doctor, {
    eager: false,
  })
  appointments!: Appointment[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}