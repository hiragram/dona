import { formatUtc, utcInstant } from './calendar.js';
import type { UtcInstant } from './calendar.js';
import { ScheduleError } from './errors.js';

export interface Clock { now(): UtcInstant }

export class SystemClock implements Clock {
  now(): UtcInstant { return formatUtc(Math.floor(Date.now() / 1000) * 1000); }
}

export class FakeClock implements Clock {
  private instant: UtcInstant;
  constructor(initial: string) { this.instant = utcInstant(initial); }
  now(): UtcInstant { return this.instant; }
  set(instant: string): void { this.instant = utcInstant(instant); }
  advance(seconds: number): void {
    if (!Number.isSafeInteger(seconds)) throw new ScheduleError('out_of_range');
    this.instant = formatUtc(Date.parse(this.instant) + seconds * 1000);
  }
}
