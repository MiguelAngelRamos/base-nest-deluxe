// src/users/users.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';

@Module({
  // forFeature registra la entidad User en este módulo
  // habilita la inyección de Repository<User> en UsersService
  // sin esto el servicio no puede acceder a la tabla users
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  // exports permite que otros módulos usen UsersService
  // AuthModule lo necesitará para verificar credenciales
  exports: [UsersService],
})
export class UsersModule {}
