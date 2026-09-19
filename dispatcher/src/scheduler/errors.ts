export type ScheduleErrorCode =
  | 'invalid_json' | 'unknown_version' | 'invalid_recurrence' | 'invalid_policy'
  | 'invalid_definition' | 'invalid_timezone' | 'tzdb_unavailable'
  | 'invalid_local_date' | 'invalid_local_time' | 'invalid_instant'
  | 'out_of_range' | 'invalid_preview_limit' | 'invalid_creation_time' | 'local_time_gap';

export class ScheduleError extends Error {
  constructor(public readonly code: ScheduleErrorCode) {
    super(code);
    this.name = 'ScheduleError';
  }
}
