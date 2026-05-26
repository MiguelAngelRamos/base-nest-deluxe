// src/users/entities/user.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// El enum define los roles posibles del sistema
// Vivir aquí evita strings mágicos en toda la aplicación
export enum UserRole {
  ADMIN = 'admin',
  DOCTOR = 'doctor',
  PATIENT = 'patient',
}

// @Entity() le indica a TypeORM que esta clase
// representa una tabla en la base de datos
// El string 'users' define el nombre exacto de la tabla
@Entity('users')
export class User {
  // @PrimaryGeneratedColumn('uuid') genera un UUID v4 automáticamente
  // Usamos UUID en lugar de integer autoincremental por seguridad:
  // un ID numérico expone el volumen de registros y permite
  // enumerar recursos — OWASP A01: Broken Access Control
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // unique: true garantiza a nivel de base de datos
  // que no pueden existir dos usuarios con el mismo email
  // La validación en el servicio no es suficiente —
  // la restricción debe existir también en la base de datos
  @Column({ unique: true, length: 255 })
  email!: string;

  // La contraseña siempre se almacena hasheada con Argon2id
  // nunca en texto plano — el campo se llama passwordHash
  // para dejar claro en el código que no es texto plano
  @Column({ name: 'password_hash' })
  passwordHash!: string;

  // El tipo 'enum' en PostgreSQL crea un tipo personalizado
  // que restringe los valores posibles a nivel de base de datos
  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.PATIENT,
  })
  role!: UserRole;

  // Permite desactivar un usuario sin eliminarlo
  // Eliminar registros de usuarios puede romper integridad
  // referencial con otras tablas — soft delete es más seguro
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  // Hash del refresh token — nunca se guarda en texto plano
  // Argon2id lo hashea antes de persistir igual que la contraseña
  // nullable: true porque al crear el usuario aún no tiene refresh
  // token — se asigna solo después del primer login exitoso
  // OWASP A02:2025 Cryptographic Failures — tokens en DB hasheados
  @Column({ name: 'refresh_token_hash', type: 'varchar', nullable: true })
  refreshTokenHash!: string | null;

  // @CreateDateColumn lo gestiona TypeORM automáticamente
  // registra la fecha exacta de creación del registro
  // nunca debe modificarse manualmente
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  // @UpdateDateColumn lo actualiza TypeORM automáticamente
  // cada vez que el registro es modificado
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}

/**
 * La solución correcta para entidades TypeORM
Usar el operador ! — Non-null assertion operator. Le dice a TypeScript: "confía en mí, esta propiedad será inicializada por TypeORM en runtime":
 */
