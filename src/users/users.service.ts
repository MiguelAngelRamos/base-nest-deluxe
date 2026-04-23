// src/users/users.service.ts

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// @Injectable() marca esta clase como un proveedor inyectable
@Injectable()
export class UsersService {

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: POST /users almacenaba password en texto plano (#2)
  // Mitigación: el hash con Argon2id vive DENTRO de este método —
  //   único punto de creación de User. AuthService.register deja
  //   de pre-hashear; pasa la contraseña plana y delega.
  // Justificación OWASP A02:2025 Cryptographic Failures + A04:
  //   el invariante "las contraseñas se almacenan hasheadas" se
  //   garantiza en el lugar donde ocurre la persistencia, no en
  //   los callers. Elimina la ambigüedad de contrato que permitía
  //   que un caller olvidara hashear.
  // ─────────────────────────────────────────────
  async create(createUserDto: CreateUserDto): Promise<User> {

    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException(
        `El email ${createUserDto.email} ya está registrado`,
      );
    }

    // Argon2id: memoria 64MB, 3 iteraciones, 4 hilos — OWASP Password
    // Storage Cheat Sheet. Resistente a GPU y side-channel.
    const passwordHash = await argon2.hash(createUserDto.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const user = this.userRepository.create({
      email: createUserDto.email,
      passwordHash,
      role: createUserDto.role,
    });

    return this.userRepository.save(user);
  }

  async findAll(): Promise<User[]> {
    return this.userRepository.find({
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${id} no encontrado`);
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email },
    });
  }

  // ─────────────────────────────────────────────
  // [SECURE-FIX] A04 - Insecure Design
  // Vulnerabilidad: rotación de contraseña también debe hashear (#2)
  // Mitigación: si UpdateUserDto incluye password, se rehashea aquí
  //   antes de persistir. Evita que un admin actualizando un usuario
  //   deje la contraseña en texto plano.
  // Justificación OWASP A02:2025: mismo invariante que create.
  // ─────────────────────────────────────────────
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingUser = await this.userRepository.findOne({
        where: { email: updateUserDto.email },
      });

      if (existingUser) {
        throw new ConflictException(
          `El email ${updateUserDto.email} ya está registrado`,
        );
      }
    }

    // Construimos el patch SIN la propiedad password plana —
    // si viene, la convertimos a passwordHash hasheado
    const { password, ...rest } = updateUserDto;
    Object.assign(user, rest);

    if (password) {
      user.passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });
    }

    return this.userRepository.save(user);
  }

  async remove(id: string): Promise<void> {
    const user = await this.findOne(id);

    // Soft delete — mantiene integridad referencial
    user.isActive = false;
    await this.userRepository.save(user);
  }
}
