import { encode, idPattern, object, sha256, SyncError } from './model';
import { PluginFiles, type InstalledPlugin } from './plugin-disk';
import {
  candidates, canonical, encodeHead, field, fieldName, fieldValue, sameValues, settingValue, signHead, verifyHead,
  type Candidate, type Clock, type FieldValue, type PluginHead, type PluginPackage, type SignedHead, type VerifiedHead,
} from './plugin-profile';
import { PluginCatalog, PluginTransfer } from './plugin-transfer';
import { allowedPreference, safePreferenceKey } from './plugin-preferences';

export interface PluginSyncState {
  schema: 1; source: string; initialized: boolean; seen: Clock;
  own: SignedHead | null; outbox: boolean; baseline: Record<string, FieldValue>;
  peers: Record<string, { seq: number; hash: string; fingerprint: string }>;
  trustedCode: Record<string, string>; pending: Record<string, Clock>;
  excluded: string[];
}
export interface PluginRow {
  id: string; localVersion: string; version: string; enabled: boolean;
  status: 'same' | 'excluded' | 'pending' | 'conflict' | 'trust' | 'review' | 'error';
  unapproved: string[];
  localFields: string[]; conflicts: { path: string; choices: Candidate[] }[];
  localTasks: string[];
  error?: SyncError['code'];
}
export interface PluginSyncStorage { read(): unknown; write(state: PluginSyncState): void; signingKey(): Promise<string> }

export class PluginSync {
  rows: PluginRow[] = [];
  heads: VerifiedHead[] = [];
  fingerprint = '';
  private state: PluginSyncState | null = null;
  private busy = false;
  constructor(readonly files: PluginFiles, private readonly transfer: PluginTransfer, private readonly catalog: PluginCatalog,
    private readonly vault: string, readonly device: string, private readonly storage: PluginSyncStorage,
    private readonly check: () => void = () => {},
    private readonly progress?: (completed: number, total: number) => void,
  ) {
    if (!idPattern.test(vault) || !idPattern.test(device)) throw new SyncError('identity');
    const saved = storage.read();
    if (saved !== null && saved !== undefined) {
      if (!object(saved) || saved.schema !== 1 || typeof saved.source !== 'string' || !idPattern.test(saved.source)
        || typeof saved.initialized !== 'boolean' || typeof saved.outbox !== 'boolean'
        || !object(saved.seen) || !object(saved.baseline) || !object(saved.peers)
        || !object(saved.trustedCode) || !object(saved.pending) || !Array.isArray(saved.excluded)
        || !saved.excluded.every(id => typeof id === 'string')) throw new SyncError('integrity');
      this.state = saved as unknown as PluginSyncState;
    }
  }
  configured(): boolean { return this.state !== null; }
  planSignature(): string { return canonical(this.heads.map(head => head.envelope.body).sort()); }
  exclude(id: string, value: boolean): void {
    if (!this.state) throw new SyncError('inactive');
    field(fieldName(id, 'package'));
    this.state.excluded = value ? [...new Set([...this.state.excluded, id])] : this.state.excluded.filter(item => item !== id);
    this.save();
  }
  approveFields(id: string, names: string[]): void {
    if (names.some(name => !safePreferenceKey(name))) throw new SyncError('configuration');
    this.files.extra[id] = [...new Set(names)];
  }
  private save(): void {
    if (!this.state) return;
    if (JSON.stringify(this.state).length > 4 * 1024 * 1024) throw new SyncError('size');
    this.storage.write(this.state);
  }
  private async own(): Promise<VerifiedHead | null> {
    return this.state?.own ? verifyHead(encodeHead(this.state.own), this.vault, this.device) : null;
  }
  async identify(): Promise<string> {
    const envelope = await signHead({ schema: 1, vault: this.vault, device: this.device, seq: 1, edits: {} }, await this.storage.signingKey());
    this.fingerprint = (await verifyHead(encodeHead(envelope), this.vault, this.device)).fingerprint;
    return this.fingerprint;
  }
  async discover(devices: string[]): Promise<VerifiedHead[]> {
    const heads: VerifiedHead[] = [];
    for (const device of [...new Set(devices)].filter(id => id !== this.device)) {
      this.check();
      const head = await this.transfer.head(device);
      if (head) heads.push(head);
    }
    return heads;
  }
  async initialize(source: string): Promise<void> {
    if (this.state || !idPattern.test(source)) throw new SyncError('identity');
    const existing = await this.transfer.head(this.device);
    if (existing) throw new SyncError('identity');
    if (source !== this.device && !await this.transfer.head(source)) throw new SyncError('missing');
    await this.identify();
    this.state = { schema: 1, source, initialized: source === this.device, seen: {}, own: null,
      outbox: false, baseline: {}, peers: {}, trustedCode: {}, pending: {}, excluded: [] };
    this.save();
  }
  trust(device: string, fingerprint: string): void {
    const head = this.heads.find(h => h.data.device === device);
    const normalized = fingerprint.replace(/[\s:-]/g, '').toLowerCase();
    if (!this.state || !head || normalized !== head.fingerprint || normalized.length !== 64) throw new SyncError('plugin-key');
    this.state.trustedCode[device] = normalized;
    this.save();
  }
  trusts(device: string): boolean {
    const head = this.heads.find(item => item.data.device === device);
    return !!head && this.state?.trustedCode[device] === head.fingerprint;
  }
  revoke(device: string): void {
    if (!this.state) return;
    delete this.state.trustedCode[device];
    this.save();
  }
  private async publish(): Promise<void> {
    const state = this.state!;
    if (!state.outbox || !state.own) return;
    const own = (await this.own())!;
    this.save();
    let remote: VerifiedHead | null;
    try { remote = await this.transfer.head(this.device); }
    catch (error) {
      if (!(error instanceof SyncError) || !['integrity', 'configuration', 'protocol'].includes(error.code)) throw error;
      // A torn head from our unfinished PUT can be repaired only from its exact verified archived outbox.
      const archived = await this.transfer.archived(this.device, own.data.seq);
      if (archived.fingerprint !== own.fingerprint || archived.envelope.body !== own.envelope.body) throw error;
      remote = archived;
    }
    if (remote && (remote.fingerprint !== own.fingerprint || remote.data.seq > own.data.seq
      || (remote.data.seq === own.data.seq && remote.envelope.body !== own.envelope.body))) throw new SyncError('identity');
    await this.transfer.publish(this.device, state.own);
    state.outbox = false;
    state.seen[this.device] = own.data.seq;
    this.save();
  }
  private async capture(installed: InstalledPlugin[]): Promise<void> {
    const state = this.state!;
    if (!state.initialized) return;
    const local = this.files.fields(installed);
    const previous = await this.own();
    const next: PluginHead = previous ? structuredClone(previous.data)
      : { schema: 1, vault: this.vault, device: this.device, seq: 0, edits: {} };
    const changes = new Map<string, FieldValue>();
    for (const path of new Set([...Object.keys(local), ...Object.keys(state.baseline)])) {
      const f = field(path);
      if (state.excluded.includes(f.id)) continue;
      if (f.kind === 'setting' && local[path] === undefined && installed.some(p => p.id === f.id)) {
        // Removing consent or encountering a nonportable value is not a deletion of that setting.
        const raw = await this.files.rawSettings(f.id);
        if (!allowedPreference(f.id, f.key, this.files.extra[f.id]) || Object.prototype.hasOwnProperty.call(raw, f.key)) continue;
      }
      const value = fieldValue(local, path);
      if ((Object.prototype.hasOwnProperty.call(local, path) && !Object.prototype.hasOwnProperty.call(state.baseline, path))
        || canonical(value) !== canonical(fieldValue(state.baseline, path))) changes.set(path, value);
    }
    const localInfo: PluginHead['local'] = Object.fromEntries(installed.map(p => [p.id, {
      fields: p.localFields.filter(k => /^[a-zA-Z0-9_.-]{1,120}$/.test(k)), required: p.requiredLocal,
    }]));
    if (!previous || changes.size || canonical(next.local ?? {}) !== canonical(localInfo)) {
      next.local = localInfo;
      next.seq++;
      const total = [...changes].filter(([path, value]) => field(path).kind === 'package' && value !== null)
        .reduce((count, [, value]) => count + Object.keys((value as PluginPackage).files).length, 0);
      let completed = 0;
      if (total) this.progress?.(0, total);
      for (const [path, value] of changes) {
        const f = field(path);
        if (f.kind === 'package' && value !== null) {
          const pkg = value as PluginPackage;
          for (const [name, ref] of Object.entries(pkg.files)) {
            this.check();
            const bytes = await this.files.packageBytes(f.id, name);
            if (bytes.byteLength !== ref.size || await sha256(bytes) !== ref.hash) throw new SyncError('changed');
            await this.transfer.upload(bytes);
            this.progress?.(++completed, total);
          }
        }
        next.edits[path] = { seq: next.seq, seen: { ...(state.pending[path] ?? state.seen), [this.device]: next.seq - 1 }, value };
      }
      const envelope = await signHead(next, await this.storage.signingKey());
      // Persist the exact signed outbox before any head publication. An uncertain PUT reuses it.
      state.own = envelope;
      state.outbox = true;
      for (const [path, value] of changes) state.baseline[path] = value;
      this.save();
      await this.publish();
    }
  }
  private async receive(devices: string[]): Promise<VerifiedHead[]> {
    const state = this.state!;
    const heads: VerifiedHead[] = [];
    const ids = [...new Set([...devices, ...Object.keys(state.peers), state.source])].filter(id => id !== this.device);
    for (const id of ids) {
      this.check();
      const head = await this.transfer.head(id);
      const old = state.peers[id];
      if (!head) { if (old) throw new SyncError('missing'); continue; }
      const hash = await sha256(encode(head.envelope.body));
      if (old && (old.fingerprint !== head.fingerprint || head.data.seq < old.seq
        || (head.data.seq === old.seq && hash !== old.hash))) throw new SyncError('integrity');
      state.peers[id] = { seq: head.data.seq, hash, fingerprint: head.fingerprint };
      heads.push(head);
    }
    const own = await this.own();
    if (own) heads.push(own);
    return heads;
  }
  private async packageBytes(id: string, pkg: PluginPackage, sources: Candidate[]): Promise<Map<string, ArrayBuffer>> {
    // The catalog is independently resolved; a remote profile cannot substitute a repository URL.
    const trusted = sources.some(s => s.device === this.device || this.state!.trustedCode[s.device] === s.fingerprint);
    if (!trusted) {
      const official = await this.catalog.package(id, pkg.version, pkg.files);
      if (official) return official;
      throw new SyncError('plugin-trust');
    }
    const result = new Map<string, ArrayBuffer>();
    for (const [name, ref] of Object.entries(pkg.files)) { this.check(); result.set(name, await this.transfer.blob(ref)); }
    return result;
  }
  async resolve(path: string, device: string): Promise<void> {
    if (!this.state || this.busy) throw new SyncError('busy');
    const selected = candidates(this.heads)[path]?.find(c => c.device === device);
    if (!selected) throw new SyncError('changed');
    const f = field(path);
    if (f.kind === 'package' && selected.edit.value !== null) await this.packageBytes(f.id, selected.edit.value as PluginPackage, [selected]);
    const own = await this.own();
    const next: PluginHead = own ? structuredClone(own.data)
      : { schema: 1, vault: this.vault, device: this.device, seq: 0, edits: {} };
    next.seq++;
    next.edits[path] = { seq: next.seq, seen: { ...this.state.seen, [this.device]: next.seq - 1 }, value: selected.edit.value };
    this.state.own = await signHead(next, await this.storage.signingKey());
    this.state.outbox = true;
    this.save();
    await this.publish();
  }
  async run(devices: string[], applyLoaded = false, expectedPlan?: string, forceScan = false): Promise<PluginRow[]> {
    if (!this.state) return [];
    if (this.busy) throw new SyncError('busy');
    this.busy = true;
    try {
      this.check();
      if (await this.files.interrupted()) {
        if (!applyLoaded) throw new SyncError('plugin-recovery');
        await this.files.recover(true);
      }
      await this.publish();
      let installed = await this.files.scan(forceScan);
      await this.capture(installed);
      const beforeSeen = { ...this.state.seen };
      this.heads = await this.receive(devices);
      if (applyLoaded && expectedPlan !== undefined && this.planSignature() !== expectedPlan) throw new SyncError('changed');
      const own = this.heads.find(h => h.data.device === this.device);
      if (own) this.fingerprint = own.fingerprint;
      for (const head of this.heads) this.state.seen[head.data.device] = head.data.seq;
      const activeHeads = this.state.initialized ? this.heads : this.heads.filter(h => h.data.device === this.state!.source);
      const merged = candidates(activeHeads);
      this.rows = [];
      const groups = new Map<string, string[]>();
      for (const path of Object.keys(merged)) {
        const id = field(path).id;
        groups.set(id, [...groups.get(id) ?? [], path]);
      }
      for (const [id, groupPaths] of groups) {
        this.check();
        const current = installed.find(p => p.id === id);
        // A local absolute path or other nonportable value remains local even if the peer has a portable value.
        const paths = groupPaths.filter(path => {
          const f = field(path);
          return f.kind !== 'setting' || !allowedPreference(id, f.key, this.files.extra[id]) || !current?.localFields.includes(f.key);
        });
        const packagePath = fieldName(id, 'package');
        const packageCandidates = merged[packagePath] ?? [];
        const pkg = packageCandidates[0]?.edit.value as PluginPackage | null | undefined;
        const enabled = merged[fieldName(id, 'enabled')]?.[0]?.edit.value === true;
        const row: PluginRow = { id, localVersion: current?.pkg.version ?? '', version: pkg?.version ?? '', enabled,
          status: 'same', localFields: [...new Set([...(current?.localFields ?? []),
            ...activeHeads.flatMap(head => head.data.local?.[id]?.fields ?? [])])].sort(), conflicts: [], unapproved: [], localTasks: [] };
        const raw = await this.files.rawSettings(id);
        row.localTasks = [...new Set(activeHeads.flatMap(head => head.data.local?.[id]?.required ?? []))]
          .filter(key => raw[key] === undefined || raw[key] === null || raw[key] === '' || (Array.isArray(raw[key]) && raw[key].length === 0));
        this.rows.push(row);
        if (this.state.excluded.includes(id)) { row.status = 'excluded'; continue; }
        const values = this.files.fields(current ? [current] : []);
        for (const path of paths) {
          const choices = merged[path]!;
          if (!sameValues(choices)) row.conflicts.push({ path, choices });
          const local = fieldValue(values, path);
          if (!sameValues(choices) || canonical(local) !== canonical(choices[0]?.edit.value)) {
            this.state.pending[path] ??= beforeSeen;
          }
        }
        if (row.conflicts.length) { row.status = 'conflict'; continue; }
        if (pkg === undefined) { row.status = 'error'; row.error = 'configuration'; continue; }
        const settings: Record<string, FieldValue> = {};
        for (const path of paths) {
          const f = field(path);
          if (f.kind === 'setting') {
            settings[f.key] = merged[path]![0]!.edit.value;
            if (!allowedPreference(id, f.key, this.files.extra[id])) row.unapproved.push(f.key);
          }
        }
        if (row.unapproved.length) { row.status = 'review'; continue; }
        const packageChanged = canonical(current?.pkg ?? null) !== canonical(pkg);
        const settingsChanged = Object.entries(settings).some(([k, v]) => canonical(settingValue(current?.settings ?? {}, k)) !== canonical(v));
        const enabledChanged = (current?.enabled ?? false) !== (pkg !== null && enabled);
        if (packageChanged || settingsChanged || enabledChanged) {
          row.status = 'pending';
          const canHotReload = !packageChanged && !enabledChanged && this.files.canReloadSettings(id);
          if (!applyLoaded && current && (pkg === null || (this.files.loaded(id) && !canHotReload))) continue;
          try {
            const bytes = pkg && packageChanged ? await this.packageBytes(id, pkg, packageCandidates) : new Map<string, ArrayBuffer>();
            this.check();
            await this.files.apply(id, current, pkg, bytes, settings, enabled);
            installed = await this.files.scan(true);
            const actual = installed.find(p => p.id === id);
            const actualFields = this.files.fields(actual ? [actual] : []);
            // Startup hooks may migrate settings. Do not announce success or export those defaults silently.
            for (const path of paths) {
              const actualValue = fieldValue(actualFields, path);
              if (canonical(actualValue) !== canonical(merged[path]![0]!.edit.value)) throw new SyncError('changed');
            }
            row.localVersion = actual?.pkg.version ?? '';
            row.localFields = [...new Set([...row.localFields, ...actual?.localFields ?? []])].sort();
            row.status = 'same';
          } catch (error) {
            row.error = error instanceof SyncError ? error.code : 'local';
            row.status = row.error === 'plugin-trust' ? 'trust' : 'error';
            if (await this.files.interrupted()) throw new SyncError('plugin-recovery');
            continue;
          }
        }
        for (const path of paths) {
          this.state.baseline[path] = merged[path]![0]!.edit.value;
          delete this.state.pending[path];
        }
        this.save();
      }
      if (!this.state.initialized && this.rows.every(row => row.status === 'same' || row.status === 'excluded') && activeHeads.length > 0) {
        this.state.initialized = true;
      }
      this.save();
      return this.rows;
    } finally { this.busy = false; }
  }
}
