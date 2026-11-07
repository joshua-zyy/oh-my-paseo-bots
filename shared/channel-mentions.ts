// Adapted from DS-Bot shared/mentions.js (5c514ad), Apache-2.0.
// Copyright 2026 Fei2411 and the DS Bot contributors. See THIRD_PARTY_NOTICES.md.
// Changes: resolve stable Bot IDs as well as names; report ambiguous identities.
const NAME_GOES_ON = /^(?:[a-z0-9_\-/\\]|\.[a-z0-9_-])/i;
const ADDRESS_BEFORE = /[a-z0-9_./]/i;
const LITERAL = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g;
const ALL_WORDS = ['all', 'everyone', '所有人', '全体'];

/** Only explicit mentions outside code, links, paths and addresses call colleagues. */
export function channelMentions(text: string, bots: readonly { id: string; name: string }[]) {
  const skip = [...text.matchAll(LITERAL)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  const aliases = bots.flatMap(bot => [...new Set([bot.name, bot.id])].map(name => ({ id: bot.id, name }))).sort((a, b) => b.name.length - a.name.length);
  const fits = (at: number, name: string) => text.slice(at, at + name.length).toLowerCase() === name.toLowerCase() && !NAME_GOES_ON.test(text.slice(at + name.length));
  const ids = new Set<string>();
  let all = false;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS_BEFORE.test(text[at - 1])) || skip.some(span => at >= span.start && at < span.end)) continue;
    const found = aliases.filter(alias => fits(at + 1, alias.name));
    const first = found[0];
    if (first) {
      const matches = new Set(found.filter(alias => alias.name.length === first.name.length).map(alias => alias.id));
      if (matches.size > 1) throw new Error(`同名@${first.name}无法唯一定位，请使用同事标识`);
      ids.add(first.id); at += first.name.length;
    } else {
      const word = ALL_WORDS.find(word => fits(at + 1, word));
      if (word) { all = true; at += word.length; }
    }
  }
  return { ids: [...ids], all };
}
