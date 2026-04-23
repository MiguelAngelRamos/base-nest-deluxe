// src/users/dto/update-user.dto.ts

// Importamos PartialType desde @nestjs/swagger en lugar de
// @nestjs/mapped-types para preservar los @ApiProperty heredados
// del CreateUserDto en la documentación OpenAPI
import { PartialType } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';

// PartialType toma CreateUserDto y hace todos sus campos opcionales
// Evita duplicar las validaciones — reutiliza las de CreateUserDto
// Si un campo se envía, se valida igual que en CreateUserDto
// Si no se envía, simplemente se ignora
export class UpdateUserDto extends PartialType(CreateUserDto) {}