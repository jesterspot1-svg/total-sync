export type Locale = 'en' | 'ru';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const relative = {
  en: new Intl.RelativeTimeFormat('en', { numeric: 'always' }),
  ru: new Intl.RelativeTimeFormat('ru', { numeric: 'always', style: 'short' }),
};

export function formatSyncAge(lastSuccess: number | null, now: number, locale: Locale): {
  text: string;
  refreshIn: number | null;
} {
  const russian = locale === 'ru';
  if (lastSuccess === null || !Number.isFinite(lastSuccess)) {
    return { text: russian ? 'Синхронизации ещё не было' : 'Not synced yet', refreshIn: null };
  }

  const elapsed = Math.max(0, now - lastSuccess);
  if (elapsed < minute) {
    return {
      text: russian ? 'Синхронизация была сейчас' : 'Successfully synced just now',
      refreshIn: minute - elapsed,
    };
  }

  const [duration, unit] = elapsed >= day ? [day, 'day'] as const
    : elapsed >= hour ? [hour, 'hour'] as const : [minute, 'minute'] as const;
  const age = relative[locale].format(-Math.floor(elapsed / duration), unit);
  return {
    text: russian ? 'Синхронизация была ' + age.replace('.', '') : 'Successfully synced ' + age,
    refreshIn: duration - elapsed % duration,
  };
}
