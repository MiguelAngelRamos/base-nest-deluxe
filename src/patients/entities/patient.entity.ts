// src/patients/entities/patient.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';
import type { Appointment } from '../../appointments/entities/appointment.entity.js';

// El enum garantiza que solo se almacenen valores válidos
// a nivel de base de datos y de TypeScript simultáneamente
export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
}

@Entity('patients')
export class Patient {

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // @OneToOne define una relación uno a uno con User
  // Un paciente tiene exactamente un usuario del sistema
  // Esta separación cumple 3FN — los datos de autenticación
  // no deben mezclarse con los datos clínicos del paciente
  @OneToOne(() => User, { eager: false })

  // @JoinColumn indica que esta tabla tiene la llave foránea
  // PostgreSQL creará la columna user_id en la tabla patients
  // apuntando al id de la tabla users
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // TypeORM necesita esta propiedad separada para poder
  // filtrar por user_id sin cargar el objeto User completo
  // Evita queries innecesarias cuando solo necesitas el ID
  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ name: 'first_name', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', length: 100 })
  lastName!: string;

  // nullable: true porque el paciente puede registrarse
  // sin proporcionar su fecha de nacimiento inicialmente
  @Column({ name: 'birth_date', type: 'date', nullable: true })
  birthDate!: Date | null;

  @Column({
    type: 'enum',
    enum: Gender,
    nullable: true,
  })
  gender!: Gender | null;

  // length definido explícitamente — sin length TypeORM
  // usa varchar(255) por defecto, pero un teléfono
  // nunca necesita más de 20 caracteres
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address!: string | null;
  // Un paciente puede tener muchas citas a lo largo del tiempo
  // El lado OneToMany nunca tiene la llave foránea —
  // la llave foránea patient_id vive en la tabla appointments
  @OneToMany('Appointment', (appointment: Appointment) => appointment.patient, {
    eager: false,
  })
  appointments!: Appointment[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;



}