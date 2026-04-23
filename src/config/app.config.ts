// src/config/app.config.ts

// registerAs es una función de @nestjs/config que agrupa
// variables de entorno relacionadas bajo un namespace
// En lugar de tener todas las variables sueltas, las organizamos
// por dominio: 'app', 'database', 'jwt'
// Esto se llama Configuration Namespace — patrón de NestJS
import { registerAs } from '@nestjs/config';

// 'app' es el namespace — así accedes a esta config:
// configService.get('app.port')
export default registerAs('app', () => ({
  
  // process.env.PORT viene del archivo .env
  // El operador || define un valor por defecto
  // Si PORT no está definido, usa 3000
  port: Number.parseInt(process.env.PORT || '3000', 10),

  // El segundo argumento de parseInt es la base numérica
  // 10 = decimal — siempre especificarlo para evitar comportamientos
  // inesperados con números que empiezan en 0
  nodeEnv: process.env.NODE_ENV || 'development',
}));