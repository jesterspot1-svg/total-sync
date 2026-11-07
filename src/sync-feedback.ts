import { setIcon } from 'obsidian';
import { t } from './i18n';

const icons = { running: 'refresh-cw', success: 'check', error: 'circle-alert', cancelled: 'square' } as const;
type State = keyof typeof icons;

export class SyncFeedback {
  private readonly container: HTMLDivElement;
  private readonly badge: HTMLDivElement;
  private readonly icon: HTMLSpanElement;
  private readonly label: HTMLSpanElement;
  private readonly stopButton: HTMLButtonElement;
  private hideTimer?: number;
  private transient = false;
  private idleText = '';
  private idleTitle = '';
  private lastIssue?: 'error' | 'cancelled';
  private lastMessage = '';

  constructor(host: HTMLElement, private readonly mobile: boolean, onStop: () => void) {
    this.container = host.createDiv({
      cls: mobile ? 'total-sync-feedback total-sync-feedback-mobile' : 'total-sync-feedback-inline',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.badge = this.container.createDiv({ cls: 'total-sync-feedback-badge' });
    this.badge.hidden = true;
    this.icon = this.badge.createSpan({ cls: 'total-sync-feedback-icon', attr: { 'aria-hidden': 'true' } });
    this.label = this.badge.createSpan({ cls: 'total-sync-feedback-label' });
    this.stopButton = this.badge.createEl('button', {
      cls: 'total-sync-feedback-stop', attr: { type: 'button' }, text: t('Stop', 'Остановить'),
    });
    this.stopButton.hidden = true;
    this.stopButton.addEventListener('click', onStop);
  }

  get running(): boolean {
    return !this.badge.hidden && this.badge.dataset.state === 'running';
  }

  start(): void {
    this.stopButton.disabled = false;
    this.stopButton.textContent = t('Stop', 'Остановить');
    this.show('running', t('Syncing…', 'Синхронизация…'));
  }

  setIdle(text: string, exactTime: string | null): void {
    this.idleText = text;
    this.idleTitle = exactTime ?? text;
    if (!this.transient) this.renderIdle();
  }

  progress(completed: number, total: number): void {
    if (!this.running || this.stopButton.disabled || total === 0) return;
    const prefix = completed === total ? t('Finalizing…', 'Завершение…') : t('Syncing…', 'Синхронизация…');
    const files = total % 10 === 1 && total % 100 !== 11 ? 'файла' : 'файлов';
    this.label.textContent = prefix + ' ' + t(`${completed} of ${total} ${total === 1 ? 'file' : 'files'}`, `${completed} из ${total} ${files}`);
    this.badge.title = this.label.textContent;
  }

  stopping(): void {
    if (!this.running) return;
    this.stopButton.disabled = true;
    this.label.textContent = t('Stopping…', 'Остановка…');
  }

  finish(state: Exclude<State, 'running'>, text: string): void {
    this.lastIssue = state === 'success' ? undefined : state;
    this.lastMessage = this.lastIssue ? text : '';
    this.show(state, text);
    this.hideTimer = window.setTimeout(() => this.clear(), state === 'error' ? 7000 : 3500);
  }

  private show(state: State, text: string): void {
    this.transient = true;
    window.clearTimeout(this.hideTimer);
    this.badge.dataset.state = state;
    this.icon.hidden = false;
    setIcon(this.icon, icons[state]);
    this.badge.hidden = false;
    this.stopButton.hidden = state !== 'running';
    this.label.textContent = text;
    this.badge.title = text;
  }

  clear(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.transient = false;
    this.renderIdle();
  }

  reset(): void {
    this.lastIssue = undefined;
    this.lastMessage = '';
    this.clear();
  }

  private renderIdle(): void {
    this.badge.hidden = this.mobile;
    this.stopButton.hidden = true;
    if (this.mobile) { this.label.textContent = ''; return; }
    this.badge.dataset.state = this.lastIssue ?? 'idle';
    this.icon.hidden = this.lastIssue === undefined;
    if (this.lastIssue) setIcon(this.icon, icons[this.lastIssue]);
    this.label.textContent = this.idleText;
    this.badge.title = [this.lastMessage, this.idleTitle].filter(Boolean).join('\n');
  }

  dispose(): void {
    this.clear();
    this.container.remove();
  }
}
