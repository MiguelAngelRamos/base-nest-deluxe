// src/specialties/entities/specialty.entity.ts

import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Doctor } from '../../doctors/entities/doctor.entity.js';

@Entity('specialties')
export class Specialty {

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // unique: true porque no tiene sentido tener dos especialidades
  // con el mismo nombre — Cardiología debe existir una sola vez
  @Column({ unique: true, length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  // @ManyToMany define la relación muchos a muchos con Doctor
  // Una especialidad puede pertenecer a muchos médicos
  // Un médico puede tener muchas especialidades
  // TypeORM gestiona la tabla intermedia doctor_specialty
  // El lado que NO tiene @JoinTable es el lado inverso
  @ManyToMany(() => Doctor, (doctor) => doctor.specialties, {
    eager: false,
  })
  doctors!: Doctor[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}