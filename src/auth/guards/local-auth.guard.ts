// src/auth/guards/local-auth.guard.ts

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// LocalAuthGuard usa la estrategia 'local' de Passport
// Ejecuta LocalStrategy.validate() con email y password
// del body antes de que entre el handler del controlador.
// Si validate() retorna el usuario, lo adjunta a req.user
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
