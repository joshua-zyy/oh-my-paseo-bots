// Adapted from oliexe/paseo-bots question-form protocol. See THIRD_PARTY_NOTICES.md.
import { z } from 'zod';

const question = z.object({
  header: z.string(), question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().default(false), allowOther: z.boolean().default(false),
  isOther: z.boolean().default(false), allowEmpty: z.boolean().default(false),
  placeholder: z.string().optional(), dismissLabel: z.string().optional(),
}).transform(value => ({ ...value, allowOther: value.allowOther || value.isOther }));
export type ChatQuestion = z.output<typeof question>;
const form = z.object({ questions: z.array(question).min(1) });

/** 原生 metadata 的题目部分在这一边界验证，保留原 input 供原生回应。 */
export function parseQuestions(input: unknown): ChatQuestion[] | null {
  const result = form.safeParse(input);
  return result.success ? result.data.questions : null;
}
export function questionAnswered(question: ChatQuestion, selected: number[], text: string): boolean {
  return selected.length > 0 || ((question.options.length === 0 || question.allowOther) && (!!text.trim() || question.allowEmpty));
}
export function questionAnswers(questions: ChatQuestion[], selections: Record<number, number[]>, texts: Record<number, string>): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const labels = (selections[index] ?? []).map(option => question.options[option].label);
    const text = texts[index]?.trim();
    answers[question.header] = text && (question.options.length === 0 || question.allowOther)
      ? question.multiSelect ? [...labels, text].join(', ') : text
      : labels.join(', ');
  });
  return answers;
}
