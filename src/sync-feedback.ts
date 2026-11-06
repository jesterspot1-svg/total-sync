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

  constructor(host: HTMLElement, mobile: boolean, onStop: () => void) {
    this.container = host.createDiv({
      cls: mobile ? 'total-sync-feedback total-sync-feedback-mobile' : 'total-sync-feedback',
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    this.badge = this.container.createDiv({ cls: 'total-sync-feedback-badge' });
    this.badge.hidden = true;
    this.icon = this.badge.createEl('span', { cls: 'total-sync-feedback-icon', attr: { 'aria-hidden': 'true' } });
    this.label = this.badge.createEl('span', { cls: 'total-sync-feedback-label' });
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
    this.show('running', t('Syncing…', 'Синхронизация…'));
  }

  progress(completed: number, total: number): void {
    if (!this.running || this.stopButton.disabled || total === 0) return;
    const prefix = completed === total ? t('Finalizing…', 'Завершение…') : t('Syncing…', 'Синхронизация…');
    const files = total % 10 === 1 && total % 100 !== 11 ? 'файла' : 'файлов';
    this.label.textContent = prefix + ' ' + t(`${completed} of ${total} ${total === 1 ? 'file' : 'files'}`, `${completed} из ${total} ${files}`);
  }

  stopping(): void {
    if (!this.running) return;
    this.stopButton.disabled = true;
    this.label.textContent = t('Stopping…', 'Остановка…');
  }

  finish(state: Exclude<State, 'running'>, text: string): void {
    this.show(state, text);
    this.hideTimer = window.setTimeout(() => this.clear(), state === 'error' ? 7000 : 3500);
  }

  private show(state: State, text: string): void {
    window.clearTimeout(this.hideTimer);
    this.badge.dataset.state = state;
    setIcon(this.icon, icons[state]);
    this.badge.hidden = false;
    this.stopButton.hidden = state !== 'running';
    this.label.textContent = text;
  }

  clear(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.badge.hidden = true;
    this.label.textContent = '';
  }

  dispose(): void {
    this.clear();
    this.container.remove();
  }
}
