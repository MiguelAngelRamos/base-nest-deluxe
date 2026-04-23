import { MigrationInterface, QueryRunner } from "typeorm";

// Añade columna refresh_token_hash a la tabla users
// nullable porque al registrar un usuario aún no tiene sesión
// Se setea solo después del primer login con el hash Argon2id
// del refresh token. OWASP A02:2025 — tokens siempre hasheados
export class AddRefreshTokenToUser1776700000000 implements MigrationInterface {
    name = 'AddRefreshTokenToUser1776700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "users" ADD "refresh_token_hash" character varying`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "users" DROP COLUMN "refresh_token_hash"`,
        );
    }
}
