// src/common/filters/http-exception.filter.ts

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

// Estructura uniforme de error que se devuelve al cliente
// No incluye stack trace ni detalles internos que revelen
// implementación. OWASP A04: Insecure Design
interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

// @Catch() sin argumentos — captura TODAS las excepciones
// incluidas las no-HTTP (errores genéricos, TypeError, etc)
// Así ningún error sin formato llega al cliente por accidente
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Tratamos dos casos: HttpException conocidas de Nest y
    // cualquier otro error inesperado. Los segundos van a 500
    // con mensaje genérico — nunca el mensaje original que podría
    // revelar detalles de implementación
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Error interno del servidor';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      // getResponse() puede devolver string o un objeto con
      // { statusCode, message, error } — normalizamos ambos casos
      if (typeof res === 'string') {
        message = res;
        error = exception.name;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as { message?: string | string[]; error?: string };
        message = body.message ?? exception.message;
        error = body.error ?? exception.name;
      }

      //* [SECURE-FIX V9] Log de auditoría para 401/403. Los guards
      //* (JwtAuthGuard, RolesGuard) no emiten trazas por sí mismos,
      //* así que sin este log los intentos de acceso no autorizado
      //* quedan invisibles. Incluimos IP, método, URL y userId
      //* (si el request ya había pasado autenticación).
      //* OWASP A09 Security Logging and Monitoring Failures.
      if (
        status === HttpStatus.UNAUTHORIZED ||
        status === HttpStatus.FORBIDDEN
      ) {
        const authedRequest = request as Request & {
          user?: { id?: string };
          ip?: string;
        };
        const userId = authedRequest.user?.id ?? 'anonymous';
        const ip = authedRequest.ip ?? request.socket?.remoteAddress ?? '-';
        this.logger.warn(
          `AUTH-DENY ${status} ${request.method} ${request.url} ` +
            `ip=${ip} userId=${userId}`,
        );
      }
    } else if (exception instanceof Error) {
      // OWASP A09:2021 — Security Logging
      // Loggeamos el error completo server-side pero nunca lo
      // enviamos al cliente — solo el mensaje genérico
      this.logger.error(
        `Error no controlado en ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(body);
  }
}
