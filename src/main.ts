// src/main.ts

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import basicAuth from 'express-basic-auth';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // OWASP A05:2021 — Security Misconfiguration
  // Helmet añade cabeceras HTTP de seguridad por defecto:
  // X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security
  // Content-Security-Policy, Referrer-Policy, etc.
  app.use(helmet());

  // cookie-parser — habilita req.cookies para leer la cookie
  // HttpOnly del refresh token en POST /auth/refresh
  app.use(cookieParser());

  // OWASP A01:2021 — Broken Access Control
  // CORS restrictivo — solo permite orígenes definidos en
  // ALLOWED_ORIGINS. credentials: true permite que el navegador
  // envíe la cookie del refresh_token en requests cross-origin
  //! [PROD] Reemplazar http://localhost:4200 en ALLOWED_ORIGINS
  //!        por el dominio exacto y único del frontend de prod,
  //!        p.ej. ALLOWED_ORIGINS=https://app.clinica.cl
  //!        NUNCA usar '*' junto con credentials:true (el browser
  //!        rechaza la combinación, pero más importante: rompe el
  //!        modelo de confianza de SameSite=Strict).
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // Prefijo global — versionado desde el inicio. Facilita migrar
  // a v2 en el futuro sin romper clientes existentes
  app.setGlobalPrefix('api/v1');

  // ValidationPipe global — valida todos los DTOs automáticamente
  app.useGlobalPipes(
    new ValidationPipe({
      // whitelist: elimina propiedades no declaradas en el DTO
      whitelist: true,
      // forbidNonWhitelisted: rechaza con 400 si vienen propiedades extra
      // Más estricto — OWASP A03:2025 Injection y A04 Insecure Design
      forbidNonWhitelisted: true,
      // transform: convierte payloads a instancias de clase DTO
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Filtro global — garantiza que ninguna excepción llegue al
  // cliente con stack trace o mensaje interno. Normaliza el formato
  app.useGlobalFilters(new HttpExceptionFilter());

  // OWASP A05:2021 — Security Misconfiguration
  // Swagger solo en desarrollo — exponer documentación de la API
  // en producción revela endpoints, DTOs y estructura completa
  // a potenciales atacantes
  //! [PROD] NO bajar esta gate. NODE_ENV debe ser exactamente
  //!        'production' en el servidor desplegado; cualquier
  //!        otro valor activa Swagger con Basic Auth débil por
  //!        defecto y expone la documentación.
  if (process.env.NODE_ENV === 'development') {

    // Basic Auth sobre Swagger — aunque sea dev, la red interna
    // puede estar compartida y cualquiera podría navegar a /api/docs
    app.use(
      '/api/docs',
      basicAuth({
        users: {
          [process.env.SWAGGER_USER ?? 'admin']:
            process.env.SWAGGER_PASSWORD ?? 'change-me',
        },
        challenge: true,
      }),
    );

    const config = new DocumentBuilder()
      .setTitle('Clinic API')
      .setDescription(
        'API RESTful para gestión de clínica médica. ' +
        'Implementa OWASP Top 10 2025.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Ingresa el Access Token JWT obtenido en POST /auth/login',
        },
        'access-token',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        // persistAuthorization — Swagger recuerda el token aunque
        // recargues la página. Solo funciona en dev detrás del
        // Basic Auth, así que no es un riesgo real
        persistAuthorization: true,
      },
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
