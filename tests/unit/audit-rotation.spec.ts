import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditRotator } from '../../src/core/audit/audit-rotator.js';

describe('AuditRotator (User Story 3 - Size & Daily Rotation)', () => {
  const testLogPath = resolve(process.cwd(), 'tests/fixtures/test-audit-rotate.jsonl');

  beforeEach(() => {
    if (existsSync(testLogPath)) {
      rmSync(testLogPath, { force: true });
    }
  });

  afterEach(() => {
    if (existsSync(testLogPath)) {
      rmSync(testLogPath, { force: true });
    }
  });

  it('should not rotate when file size is under threshold', () => {
    writeFileSync(testLogPath, 'sample log entry\n', 'utf8');
    const rotator = new AuditRotator({
      logFilePath: testLogPath,
      maxFileSizeBytes: 1024,
      rotateDaily: false
    });

    const rotated = rotator.checkAndRotate();
    expect(rotated).toBeNull();
    expect(existsSync(testLogPath)).toBe(true);
  });

  it('should rotate when file size exceeds threshold', () => {
    const largeContent = 'a'.repeat(2048);
    writeFileSync(testLogPath, largeContent, 'utf8');

    const rotator = new AuditRotator({
      logFilePath: testLogPath,
      maxFileSizeBytes: 1024,
      rotateDaily: false
    });

    const rotatedPath = rotator.checkAndRotate();
    expect(rotatedPath).not.toBeNull();
    expect(existsSync(rotatedPath!)).toBe(true);
    expect(existsSync(testLogPath)).toBe(false);

    // Clean up rotated archive
    if (existsSync(rotatedPath!)) {
      rmSync(rotatedPath!, { force: true });
    }
  });
});
