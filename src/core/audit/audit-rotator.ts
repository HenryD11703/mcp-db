import { existsSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface RotatorOptions {
  readonly logFilePath: string;
  readonly maxFileSizeBytes: number;
  readonly rotateDaily: boolean;
}

export class AuditRotator {
  private readonly options: RotatorOptions;
  private lastDateString: string = '';

  constructor(options: RotatorOptions) {
    this.options = options;
    this.lastDateString = this.getCurrentDateString();
  }

  private getCurrentDateString(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Determines if the active audit log file should be rotated due to date change or size threshold.
   * If rotated, renames the current active file and returns the new rotated archive path.
   * If no rotation is required, returns null.
   */
  public checkAndRotate(): string | null {
    if (!existsSync(this.options.logFilePath)) {
      return null;
    }

    const currentDateString = this.getCurrentDateString();
    let shouldRotate = false;
    let rotationReason = '';

    // Check daily rotation
    if (this.options.rotateDaily && this.lastDateString !== currentDateString) {
      shouldRotate = true;
      rotationReason = `date-${this.lastDateString}`;
    }

    // Check file size rotation
    if (!shouldRotate && this.options.maxFileSizeBytes > 0) {
      try {
        const stats = statSync(this.options.logFilePath);
        if (stats.size >= this.options.maxFileSizeBytes) {
          shouldRotate = true;
          rotationReason = `size-${Date.now()}`;
        }
      } catch {
        return null;
      }
    }

    if (!shouldRotate) {
      return null;
    }

    const dir = dirname(this.options.logFilePath);
    const base = basename(this.options.logFilePath);
    const extIndex = base.lastIndexOf('.');
    const nameWithoutExt = extIndex > -1 ? base.slice(0, extIndex) : base;
    const ext = extIndex > -1 ? base.slice(extIndex) : '';

    const archiveName = `${nameWithoutExt}-${rotationReason}${ext}`;
    const archivePath = join(dir, archiveName);

    try {
      renameSync(this.options.logFilePath, archivePath);
      this.lastDateString = currentDateString;
      return archivePath;
    } catch {
      return null;
    }
  }
}
