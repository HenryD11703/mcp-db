/**
 * Canonical schema for a simulated legacy Guatemalan bank (~18 tables).
 * Column names deliberately mix the organizational/technical/abbreviation
 * prefixes and sensitive-root spellings the masking engine already knows
 * about (see src/core/security/unified-prefix-catalog.ts and
 * lexical-column-analyzer.ts), plus known "safe vocabulary" decoys and a
 * handful of deliberately UNCOVERED sensitive fields (card PAN, CVV,
 * password hash) to see where the current detector has gaps.
 */

export type ColumnType = 'id' | 'fk' | 'string' | 'text' | 'amount' | 'date' | 'datetime' | 'bool' | 'int';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly length?: number;
  readonly refTable?: string;
  /** Expected classification, for scoring the lexical analyzer against ground truth. */
  readonly expectedSensitive: boolean;
  readonly expectedType?: 'nit' | 'dpi' | 'email' | 'phone' | 'amount';
  readonly note?: string;
  readonly gen: (rng: () => number, ctx: RowContext) => string | number | null;
}

export interface TableSpec {
  readonly name: string;
  readonly rowCount: number;
  readonly columns: ColumnSpec[];
}

export interface RowContext {
  readonly rowIndex: number;
  readonly tableRows: Record<string, Record<string, unknown>[]>;
}

// ---------- deterministic RNG (mulberry32) so every engine gets identical data ----------
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function int(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

const NOMBRES = [
  'Maria', 'Jose', 'Carlos', 'Ana', 'Luis', 'Juana', 'Pedro', 'Rosa', 'Miguel', 'Elena',
  'Francisco', 'Gabriela', 'Victor', 'Alejandra', 'Marco', 'Patricia', 'Sergio', 'Claudia',
  'Oscar', 'Silvia', 'Byron', 'Lesbia', 'Mynor', 'Floridalma', 'Walfre', 'Zoila'
];
const APELLIDOS = [
  'Garcia', 'Lopez', 'Martinez', 'Hernandez', 'Gonzalez', 'Perez', 'Sanchez', 'Ramirez',
  'Morales', 'Diaz', 'Castillo', 'Ruiz', 'Alvarez', 'Mendez', 'Vasquez', 'Chacon', 'Xicay',
  'Tzul', 'Quiche', 'Barillas'
];
const DEPARTAMENTOS = [
  'Guatemala', 'Quetzaltenango', 'Escuintla', 'Alta Verapaz', 'Huehuetenango', 'San Marcos',
  'Peten', 'Izabal', 'Chimaltenango', 'Solola', 'Zacapa', 'Jutiapa'
];
const PUESTOS = ['Cajero', 'Gerente de Sucursal', 'Oficial de Credito', 'Auxiliar Contable', 'Auditor Interno', 'Asesor Financiero'];
const MONEDAS = [
  { codigo: 'GTQ', nombre: 'Quetzal', simbolo: 'Q' },
  { codigo: 'USD', nombre: 'Dolar Estadounidense', simbolo: '$' },
  { codigo: 'EUR', nombre: 'Euro', simbolo: '€' }
];

function modulo11CheckDigit(body: string): string {
  let sum = 0;
  const factorBase = body.length + 1;
  for (let i = 0; i < body.length; i++) {
    sum += Number(body[i]) * (factorBase - i);
  }
  const rem = sum % 11;
  const check = (11 - rem) % 11;
  return check === 10 ? 'K' : String(check);
}

function genNit(rng: () => number): string {
  const body = String(int(rng, 100000, 9999999));
  return `${body}-${modulo11CheckDigit(body)}`;
}

/** Guatemalan CUI/DPI: 13 contiguous digits, grouped 4-5-4 ("2458 91234 0101" without the spaces). */
function genDpi(rng: () => number): string {
  const first4 = String(int(rng, 1000, 9999));
  const mid5 = String(int(rng, 10000, 99999));
  const depto = String(int(rng, 1, 22)).padStart(2, '0');
  const muni = String(int(rng, 1, 30)).padStart(2, '0');
  return `${first4}${mid5}${depto}${muni}`;
}

function genEmail(rng: () => number, nombre: string, apellido: string): string {
  const domain = pick(rng, ['gmail.com', 'hotmail.com', 'empresa.com.gt', 'bancolegado.com.gt']);
  return `${nombre.toLowerCase()}.${apellido.toLowerCase()}${int(rng, 1, 999)}@${domain}`;
}

function genPhone(rng: () => number): string {
  return `+502 ${int(rng, 3000, 5999)}-${int(rng, 1000, 9999)}`;
}

function genDate(rng: () => number, startYear: number, endYear: number): string {
  const y = int(rng, startYear, endYear);
  const m = String(int(rng, 1, 12)).padStart(2, '0');
  const d = String(int(rng, 1, 28)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const TABLES: TableSpec[] = [
  {
    name: 'sucursales',
    rowCount: 15,
    columns: [
      { name: 'id_sucursal', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'nombre_sucursal', type: 'string', expectedSensitive: false, gen: (r) => `Sucursal ${pick(r, DEPARTAMENTOS)} ${int(r, 1, 9)}` },
      { name: 'direccion_sucursal', type: 'string', expectedSensitive: false, gen: (r) => `${int(r, 1, 20)} Avenida ${int(r, 1, 15)}-${int(r, 10, 99)} Zona ${int(r, 1, 21)}` },
      { name: 'gal_telefono', type: 'string', expectedSensitive: true, expectedType: 'phone', note: 'org-prefixed (gal) phone', gen: genPhone },
      { name: 'codigo_sucursal', type: 'string', expectedSensitive: false, gen: (_r, c) => `SUC-${String(c.rowIndex + 1).padStart(3, '0')}` }
    ]
  },
  {
    name: 'empleados',
    rowCount: 60,
    columns: [
      { name: 'id_empleado', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'nombre', type: 'string', expectedSensitive: false, gen: (r) => pick(r, NOMBRES) },
      { name: 'apellido', type: 'string', expectedSensitive: false, gen: (r) => pick(r, APELLIDOS) },
      { name: 'galempnit', type: 'string', expectedSensitive: true, expectedType: 'nit', note: 'triple-prefixed continuous (gal+emp) + nit', gen: genNit },
      { name: 'emp_dpi', type: 'string', expectedSensitive: true, expectedType: 'dpi', gen: genDpi },
      { name: 'correoElectronico', type: 'string', expectedSensitive: true, expectedType: 'email', note: 'camelCase', gen: (r, c) => genEmail(r, String(c.tableRows['empleados']?.[c.rowIndex]?.['nombre'] ?? 'user'), 'emp') },
      { name: 'sueldo_base', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => int(r, 3200, 28000) },
      { name: 'id_sucursal', type: 'fk', refTable: 'sucursales', expectedSensitive: false, gen: (r) => int(r, 1, 15) },
      { name: 'fecha_contratacion', type: 'date', expectedSensitive: false, gen: (r) => genDate(r, 2005, 2025) },
      { name: 'puesto', type: 'string', expectedSensitive: false, gen: (r) => pick(r, PUESTOS) },
      { name: 'estado_laboral', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['ACTIVO', 'ACTIVO', 'ACTIVO', 'SUSPENDIDO', 'BAJA']) }
    ]
  },
  {
    name: 'clientes',
    rowCount: 600,
    columns: [
      { name: 'id_cliente', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'primer_nombre', type: 'string', expectedSensitive: false, gen: (r) => pick(r, NOMBRES) },
      { name: 'primer_apellido', type: 'string', expectedSensitive: false, gen: (r) => pick(r, APELLIDOS) },
      { name: 'clinit', type: 'string', expectedSensitive: true, expectedType: 'nit', note: 'prefix (cli) continuous + nit', gen: genNit },
      { name: 'cli_dpi', type: 'string', expectedSensitive: true, expectedType: 'dpi', gen: genDpi },
      { name: 'direccion_residencial', type: 'string', expectedSensitive: false, gen: (r) => `${int(r, 1, 20)} Calle ${int(r, 1, 15)}-${int(r, 10, 99)}, ${pick(r, DEPARTAMENTOS)}` },
      { name: 'correo_contacto', type: 'string', expectedSensitive: true, expectedType: 'email', gen: (r) => genEmail(r, pick(r, NOMBRES), pick(r, APELLIDOS)) },
      { name: 'numero_telefono', type: 'string', expectedSensitive: true, expectedType: 'phone', gen: genPhone },
      { name: 'fecha_nacimiento', type: 'date', expectedSensitive: false, note: 'PII but not covered by current detector (gap)', gen: (r) => genDate(r, 1945, 2004) },
      { name: 'estado_civil', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['SOLTERO', 'CASADO', 'DIVORCIADO', 'VIUDO']) },
      { name: 'monto_ingreso_mensual', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => int(r, 2500, 60000) },
      { name: 'thumbnail_foto', type: 'string', expectedSensitive: false, note: 'safe-vocabulary decoy', gen: (_r, c) => `/fotos/cli_${c.rowIndex + 1}_thumb.jpg` }
    ]
  },
  {
    name: 'cuentas',
    rowCount: 900,
    columns: [
      { name: 'id_cuenta', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cliente', type: 'fk', refTable: 'clientes', expectedSensitive: false, gen: (r) => int(r, 1, 600) },
      { name: 'tipo_cuenta', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['AHORRO', 'CORRIENTE', 'PLAZO_FIJO']) },
      { name: 'numero_cuenta', type: 'string', expectedSensitive: false, note: 'account number, not yet classified as sensitive (gap)', gen: (r) => String(int(r, 1000000000, 9999999999)) },
      { name: 'saldo_actual', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => Number((r() * 150000).toFixed(2)) },
      { name: 'fecha_apertura', type: 'date', expectedSensitive: false, gen: (r) => genDate(r, 2000, 2025) },
      { name: 'estado_cuenta', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['ACTIVA', 'ACTIVA', 'INACTIVA', 'CANCELADA']) },
      { name: 'id_sucursal', type: 'fk', refTable: 'sucursales', expectedSensitive: false, gen: (r) => int(r, 1, 15) },
      { name: 'id_moneda', type: 'fk', refTable: 'catalogo_monedas', expectedSensitive: false, gen: (r) => int(r, 1, 3) }
    ]
  },
  {
    name: 'movimientos',
    rowCount: 4000,
    columns: [
      { name: 'id_movimiento', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cuenta', type: 'fk', refTable: 'cuentas', expectedSensitive: false, gen: (r) => int(r, 1, 900) },
      { name: 'tipo_movimiento', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['DEPOSITO', 'RETIRO', 'TRANSFERENCIA', 'PAGO_PRESTAMO', 'COMISION']) },
      { name: 'monto_transaccion', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => Number((r() * 20000).toFixed(2)) },
      { name: 'fecha_movimiento', type: 'datetime', expectedSensitive: false, gen: (r) => `${genDate(r, 2022, 2026)} ${String(int(r, 0, 23)).padStart(2, '0')}:${String(int(r, 0, 59)).padStart(2, '0')}:00` },
      { name: 'descripcion', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['Pago en linea', 'Deposito en ventanilla', 'Transferencia a tercero', 'Retiro ATM', 'Comision mensual']) },
      { name: 'saldo_posterior', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => Number((r() * 150000).toFixed(2)) },
      { name: 'canal', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['VENTANILLA', 'ATM', 'APP_MOVIL', 'WEB']) },
      { name: 'balance_sheet_id', type: 'string', expectedSensitive: false, note: 'safe-vocabulary decoy', gen: (_r, c) => `BS-${c.rowIndex + 1}` }
    ]
  },
  {
    name: 'tarjetahabientes',
    rowCount: 450,
    columns: [
      { name: 'id_tarjetahabiente', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cliente', type: 'fk', refTable: 'clientes', expectedSensitive: false, gen: (r) => int(r, 1, 600) },
      { name: 'numtarjeta', type: 'string', expectedSensitive: false, note: 'card PAN -- known gap, not covered by current sensitive roots', gen: (r) => `4${String(int(r, 100000000000000, 999999999999999)).slice(0, 15)}` },
      { name: 'cvv2', type: 'string', expectedSensitive: false, note: 'CVV -- known gap', gen: (r) => String(int(r, 100, 999)) },
      { name: 'fecha_vencimiento', type: 'string', expectedSensitive: false, gen: (r) => `${String(int(r, 1, 12)).padStart(2, '0')}/${int(r, 26, 31)}` },
      { name: 'tipo_tarjeta', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['DEBITO', 'CREDITO']) }
    ]
  },
  {
    name: 'prestamos',
    rowCount: 250,
    columns: [
      { name: 'id_prestamo', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cliente', type: 'fk', refTable: 'clientes', expectedSensitive: false, gen: (r) => int(r, 1, 600) },
      { name: 'id_empleado_autoriza', type: 'fk', refTable: 'empleados', expectedSensitive: false, gen: (r) => int(r, 1, 60) },
      { name: 'monto_prestamo', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => int(r, 5000, 500000) },
      { name: 'tasa_interes', type: 'string', expectedSensitive: false, gen: (r) => (r() * 18 + 6).toFixed(2) },
      { name: 'plazo_meses', type: 'int', expectedSensitive: false, gen: (r) => pick(r, [12, 24, 36, 48, 60, 72, 120]) },
      { name: 'saldo_pendiente', type: 'amount', expectedSensitive: true, expectedType: 'amount', gen: (r) => int(r, 0, 500000) },
      { name: 'estado_prestamo', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['VIGENTE', 'VIGENTE', 'MORA', 'CANCELADO']) },
      { name: 'fecha_otorgamiento', type: 'date', expectedSensitive: false, gen: (r) => genDate(r, 2015, 2025) }
    ]
  },
  {
    name: 'garantias',
    rowCount: 180,
    columns: [
      { name: 'id_garantia', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_prestamo', type: 'fk', refTable: 'prestamos', expectedSensitive: false, gen: (r) => int(r, 1, 250) },
      { name: 'tipo_garantia', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['HIPOTECARIA', 'FIDUCIARIA', 'PRENDARIA']) },
      { name: 'valor_estimado', type: 'amount', expectedSensitive: false, note: 'financial value -- known gap ("valor" root not in catalog)', gen: (r) => int(r, 10000, 800000) },
      { name: 'descripcion_bien', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['Vehiculo sedan', 'Bien inmueble urbano', 'Maquinaria industrial', 'Terreno rustico']) }
    ]
  },
  {
    name: 'beneficiarios',
    rowCount: 300,
    columns: [
      { name: 'id_beneficiario', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cuenta', type: 'fk', refTable: 'cuentas', expectedSensitive: false, gen: (r) => int(r, 1, 900) },
      { name: 'nombre_beneficiario', type: 'string', expectedSensitive: false, gen: (r) => `${pick(r, NOMBRES)} ${pick(r, APELLIDOS)}` },
      { name: 'benef_dpi', type: 'string', expectedSensitive: true, expectedType: 'dpi', gen: genDpi },
      { name: 'parentesco', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['CONYUGE', 'HIJO', 'HIJA', 'PADRE', 'MADRE', 'HERMANO']) },
      { name: 'porcentaje', type: 'int', expectedSensitive: false, gen: (r) => pick(r, [25, 50, 75, 100]) }
    ]
  },
  {
    name: 'poderes',
    rowCount: 90,
    columns: [
      { name: 'id_poder', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cliente', type: 'fk', refTable: 'clientes', expectedSensitive: false, gen: (r) => int(r, 1, 600) },
      { name: 'nombre_apoderado', type: 'string', expectedSensitive: false, gen: (r) => `${pick(r, NOMBRES)} ${pick(r, APELLIDOS)}` },
      { name: 'apoderado_nit', type: 'string', expectedSensitive: true, expectedType: 'nit', note: 'delimited suffix form', gen: genNit },
      { name: 'fecha_otorgamiento', type: 'date', expectedSensitive: false, gen: (r) => genDate(r, 2010, 2025) }
    ]
  },
  {
    name: 'usuarios_sistema',
    rowCount: 35,
    columns: [
      { name: 'id_usuario', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_empleado', type: 'fk', refTable: 'empleados', expectedSensitive: false, gen: (r) => int(r, 1, 60) },
      { name: 'nombre_usuario', type: 'string', expectedSensitive: false, gen: (_r, c) => `usr${c.rowIndex + 1}` },
      { name: 'e_mail', type: 'string', expectedSensitive: true, expectedType: 'email', note: 'e_mail normalization path', gen: (r) => genEmail(r, pick(r, NOMBRES), pick(r, APELLIDOS)) },
      { name: 'password_hash', type: 'string', expectedSensitive: false, note: 'credential -- out of scope for PII detector by design (gap worth flagging)', gen: (r) => Array.from({ length: 40 }, () => int(r, 0, 15).toString(16)).join('') },
      { name: 'id_rol', type: 'fk', refTable: 'roles', expectedSensitive: false, gen: (r) => int(r, 1, 5) }
    ]
  },
  {
    name: 'roles',
    rowCount: 5,
    columns: [
      { name: 'id_rol', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'nombre_rol', type: 'string', expectedSensitive: false, gen: (_r, c) => ['ADMIN', 'CAJERO', 'AUDITOR', 'GERENTE', 'CONSULTA'][c.rowIndex] ?? 'CONSULTA' },
      { name: 'descripcion', type: 'string', expectedSensitive: false, gen: () => 'Rol del sistema bancario legado' }
    ]
  },
  {
    name: 'bitacora_accesos',
    rowCount: 2000,
    columns: [
      { name: 'id_registro', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_usuario', type: 'fk', refTable: 'usuarios_sistema', expectedSensitive: false, gen: (r) => int(r, 1, 35) },
      { name: 'fecha_acceso', type: 'datetime', expectedSensitive: false, gen: (r) => `${genDate(r, 2024, 2026)} ${String(int(r, 0, 23)).padStart(2, '0')}:${String(int(r, 0, 59)).padStart(2, '0')}:00` },
      { name: 'ip_origen', type: 'string', expectedSensitive: false, gen: (r) => `10.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 0, 255)}` },
      { name: 'accion', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['LOGIN', 'LOGOUT', 'CONSULTA_CLIENTE', 'CONSULTA_CUENTA', 'ERROR_AUTH']) },
      { name: 'monitor_status', type: 'string', expectedSensitive: false, note: 'safe-vocabulary decoy', gen: (r) => pick(r, ['OK', 'WARN', 'OK']) }
    ]
  },
  {
    name: 'auditoria_transacciones',
    rowCount: 1200,
    columns: [
      { name: 'id_auditoria', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_movimiento', type: 'fk', refTable: 'movimientos', expectedSensitive: false, gen: (r) => int(r, 1, 4000) },
      { name: 'usuario_autoriza', type: 'string', expectedSensitive: false, gen: (_r, c) => `usr${int(makeRng(c.rowIndex), 1, 35)}` },
      { name: 'fecha_auditoria', type: 'datetime', expectedSensitive: false, gen: (r) => `${genDate(r, 2024, 2026)} 00:00:00` },
      { name: 'observaciones', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['Sin novedad', 'Revisado por supervisor', 'Pendiente de confirmacion', '']) }
    ]
  },
  {
    name: 'catalogo_monedas',
    rowCount: 3,
    columns: [
      { name: 'id_moneda', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'codigo_iso', type: 'string', expectedSensitive: false, gen: (_r, c) => MONEDAS[c.rowIndex]?.codigo ?? 'GTQ' },
      { name: 'nombre_moneda', type: 'string', expectedSensitive: false, gen: (_r, c) => MONEDAS[c.rowIndex]?.nombre ?? 'Quetzal' },
      { name: 'simbolo', type: 'string', expectedSensitive: false, gen: (_r, c) => MONEDAS[c.rowIndex]?.simbolo ?? 'Q' }
    ]
  },
  {
    name: 'tasas_cambio',
    rowCount: 120,
    columns: [
      { name: 'id_tasa', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_moneda', type: 'fk', refTable: 'catalogo_monedas', expectedSensitive: false, gen: (r) => int(r, 1, 3) },
      { name: 'fecha', type: 'date', expectedSensitive: false, gen: (r) => genDate(r, 2023, 2026) },
      { name: 'valor_compra', type: 'string', expectedSensitive: false, gen: (r) => (r() * 2 + 6.8).toFixed(4) },
      { name: 'valor_venta', type: 'string', expectedSensitive: false, gen: (r) => (r() * 2 + 7.0).toFixed(4) }
    ]
  },
  {
    name: 'productos_financieros',
    rowCount: 10,
    columns: [
      { name: 'id_producto', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'nombre_producto', type: 'string', expectedSensitive: false, gen: (r) => pick(r, ['Cuenta Ahorro Clasica', 'Cuenta Plus', 'Prestamo Vehicular', 'Prestamo Hipotecario', 'Tarjeta Oro', 'Tarjeta Platino']) },
      { name: 'tasa_interes_anual', type: 'string', expectedSensitive: false, gen: (r) => (r() * 15 + 5).toFixed(2) },
      { name: 'plazo_maximo_meses', type: 'int', expectedSensitive: false, gen: (r) => pick(r, [12, 36, 60, 120, 240]) },
      { name: 'requiere_garantia', type: 'bool', expectedSensitive: false, gen: (r) => (r() > 0.5 ? 1 : 0) },
      { name: 'unit_price', type: 'string', expectedSensitive: false, note: 'safe-vocabulary decoy (fee per unit)', gen: (r) => (r() * 50).toFixed(2) }
    ]
  },
  {
    name: 'direcciones',
    rowCount: 600,
    columns: [
      { name: 'id_direccion', type: 'id', expectedSensitive: false, gen: (_r, c) => c.rowIndex + 1 },
      { name: 'id_cliente', type: 'fk', refTable: 'clientes', expectedSensitive: false, gen: (r) => int(r, 1, 600) },
      { name: 'calle', type: 'string', expectedSensitive: false, gen: (r) => `${int(r, 1, 20)} Calle ${int(r, 1, 15)}-${int(r, 10, 99)}` },
      { name: 'zona', type: 'int', expectedSensitive: false, gen: (r) => int(r, 1, 25) },
      { name: 'municipio', type: 'string', expectedSensitive: false, gen: (r) => pick(r, DEPARTAMENTOS) },
      { name: 'departamento', type: 'string', expectedSensitive: false, gen: (r) => pick(r, DEPARTAMENTOS) },
      { name: 'codigo_postal', type: 'string', expectedSensitive: false, gen: (r) => String(int(r, 1000, 22999)) }
    ]
  }
];
