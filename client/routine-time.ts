// Common cron descriptions adapted from oliexe/paseo-bots shared/routines.ts.
// See THIRD_PARTY_NOTICES.md. Scheduling remains with Paseo.
export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function describeRoutineCron(expression: string): string {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|[0-6])$/.exec(expression.trim());
  if (!match) return expression;
  const [, minute, hour, weekday] = match;
  const frequency = weekday === '*' ? '每天' : weekday === '1-5' ? '工作日' : `每${WEEKDAYS[Number(weekday)]}`;
  return `${frequency} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}
