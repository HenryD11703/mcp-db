import { z } from 'zod';
import type {
  EngineDialect,
  ReadOnlyVerificationResult,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryResult
} from '../../src/contracts/database-adapter.js';

/**
 * Dialectos de motor de base de datos ampliados.
 * Integra 'mysql', 'mariadb' y 'sqlite' junto a 'tsql' y 'postgres'.
 */
export const ExtendedEngineDialectSchema = z.enum([
  'tsql',
  'postgres',
  'mysql',
  'mariadb',
  'sqlite'
]);
export type ExtendedEngineDialect = z.infer<typeof ExtendedEngineDialectSchema>;

/**
 * Esquema de configuración de conexión para MySQL y MariaDB.
 */
export const MySqlConnectionConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(3306),
  user: z.string().min(1),
  password: z.string().min(0),
  database: z.string().min(1),
  connectionLimit: z.number().int().positive().default(5),
  connectTimeoutMs: z.number().int().positive().default(5000),
  ssl: z.boolean().optional()
});
export type MySqlConnectionConfig = z.infer<typeof MySqlConnectionConfigSchema>;

/**
 * Esquema de configuración para SQLite con lista blanca estricta de rutas.
 */
export const SqliteConnectionConfigSchema = z.object({
  filePath: z.string().min(1),
  allowedDirectories: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().default(5000)
});
export type SqliteConnectionConfig = z.infer<typeof SqliteConnectionConfigSchema>;

/**
 * Contrato de soporte para cancelación activa en menos de 500ms.
 */
export interface ICancellableAdapter {
  cancelQuery(queryId: string): Promise<boolean>;
}

/**
 * Metadatos de columna enriquecidos para introspección segura.
 */
export interface EnrichedColumnMetadata {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly isSensitive: boolean;
  readonly sensitiveType?: string;
  readonly isMasked: boolean;
  readonly sampleValues?: never; // Estrictamente omitido para columnas sensibles
}
