export type StoreErrorCode = 'invalid_input' | 'bot_exists' | 'bot_not_found' | 'bot_archived' | 'memory_not_found' | 'memory_conflict' | 'creation_not_found' | 'request_conflict' | 'corrupt_store';

/** 请求主体已不再拥有原生场景权限，边界转换为403，不吞掉其他内部错误。 */
export class ScopeAccessError extends Error {}

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details?: { field?: string; issues?: string[] };
  constructor(code: StoreErrorCode, message: string, details?: { field?: string; issues?: string[] }) {
    super(message);
    this.name = 'StoreError'; this.code = code; this.details = details;
  }
}
