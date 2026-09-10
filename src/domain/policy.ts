import type { AppConfig } from '../app/config.ts';
import { mutableSchema, type ImportRecord } from './memory.ts';
import { AppError } from '../shared/errors.ts';
import { REDACTED, sensitiveName, scanCredentials } from './credentials.ts';

const keyPattern = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g;
const redactedFieldsSchema = mutableSchema.pick({ content:true, title:true, metadata:true });
export class PolicyEngine {
  private config: AppConfig['policy']; private custom: RegExp[];
  constructor(config: AppConfig['policy']) {
    this.config=config;
    try { this.custom=config.secretPatterns.map(pattern => new RegExp(pattern,'gu')); }
    catch { throw new AppError('VALIDATION_ERROR','A configured secret pattern is not a valid regular expression.'); }
  }
  private contains(text: string): boolean { return [keyPattern,privateKey,...this.custom].some(regex => { regex.lastIndex=0;return regex.test(text); }) || scanCredentials(text).secret; }
  checkSecrets(text: string): void {
    if (this.config.secretDetection && this.contains(text)) throw new AppError('VALIDATION_ERROR','Secret-like data rejected by memory policy. Remove credentials before storing it.');
  }
  private redact(text: string): string {
    let result=scanCredentials(text.replace(keyPattern,REDACTED).replace(privateKey,REDACTED)).text;
    for (const pattern of this.custom) result=result.replace(pattern,'[REDACTED]'); return result;
  }
  private clean(value: unknown, key = ''): unknown {
    if (sensitiveName.test(key) && value!==null && value!==undefined) return '[REDACTED]';
    if (typeof value==='string') return this.redact(value);
    if (Array.isArray(value)) return value.map(v => this.clean(v));
    if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,this.clean(v,k)]));
    return value;
  }
  private checkValue(value: unknown, key = ''): void {
    if (sensitiveName.test(key) && value!==null && value!==undefined && value!==REDACTED) throw new AppError('VALIDATION_ERROR','Secret-like data rejected by memory policy. Remove credentials before storing it.');
    if (typeof value==='string') this.checkSecrets(value);
    else if (Array.isArray(value)) value.forEach(v=>this.checkValue(v));
    else if (value && typeof value==='object') for (const [k,v] of Object.entries(value)) this.checkValue(v,k);
  }
  apply<T extends ImportRecord>(input: T, defaults = true): T {
    const v={ ...input }; const cfg=this.config; const type=v.type ?? 'note';
    if (((defaults || v.type!==undefined) && cfg.rejectTypes.includes(type)) || cfg.rejectSources.includes(v.source ?? '') || cfg.rejectNamespaces.includes(v.namespace ?? '')) throw new AppError('VALIDATION_ERROR','Memory type, source or namespace is rejected by the configured policy.');
    if (Buffer.byteLength(v.content)>cfg.maxContentBytes) throw new AppError('VALIDATION_ERROR','Content exceeds the configured policy size limit.');
    if (defaults) {
      const typeDefaults=cfg.typeDefaults[type];
      if (v.importance===undefined && typeDefaults?.importance!==undefined) v.importance=typeDefaults.importance;
      const ttl=typeDefaults?.ttlDays ?? cfg.defaultTtlDays;
      if (v.expires_at===undefined && ttl!==null) v.expires_at=new Date(Date.now()+ttl*86400000).toISOString();
    }
    const importance=v.importance ?? (defaults ? 5 : undefined);
    if (importance!==undefined && importance<cfg.minimumImportance) throw new AppError('VALIDATION_ERROR','Memory importance is below the configured minimum.');
    if (cfg.secretDetection) {
      if (cfg.secretAction==='reject') this.checkValue(v);
      else {
        const { content,title,metadata,...other }=v; this.checkSecrets(JSON.stringify(other));
        v.content=this.redact(content); if (typeof title==='string') v.title=this.redact(title);
        if (metadata) v.metadata=this.clean(metadata) as Record<string,unknown>;
        // Replacements can be longer than the secret. Enforce storage/round-trip
        // limits on the transformed record as well as on the original input.
        if (Buffer.byteLength(v.content)>cfg.maxContentBytes) throw new AppError('VALIDATION_ERROR','Redacted content exceeds the configured policy size limit.');
        redactedFieldsSchema.parse({ content:v.content,title:v.title,metadata:v.metadata });
      }
    }
    return v;
  }
}
