/** What the live input box shows: the words of whoever is speaking now. The other speaker's earlier words never come
 * back, and the customer's own sentences stay together across their pauses. */
export interface TalkMemory {
  /** The interviewer's latest text as the app sends it (it can still hold earlier, unsent sentences). */
  interviewerHeard: string;
  /** Interviewer words from before the customer took the box over: hidden when they are sent again. */
  interviewerPassed: string;
  /** The customer's finished sentences since the interviewer last spoke, or since Send or Clear. */
  mine: string;
}
export const EMPTY_TALK: TalkMemory = Object.freeze({ interviewerHeard: '', interviewerPassed: '', mine: '' });
const MAX_MINE = 4_000;
/** This many words from the customer count as a reply. */
const REAL_REPLY_WORDS = 4;
/** Questions can be at most this long. */
export const MAX_QUESTION = 5_000;
/** For this long after Send or Clear, the same words arriving again (a late update) do not refill the box. */
const HANDLED_MS = 4_000;

const plainWord = (word: string): string => word.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const plain = (text: string): string => text.split(/\s+/).map(plainWord).filter(Boolean).join(' ');

/** The most recent words of a very long text, cut between words. */
export function latestWords(text: string, max = MAX_QUESTION): string {
  return text.length <= max ? text : text.slice(-max).replace(/^\S*\s+/, '');
}

/** `text` without the words `passed` that it starts with, or null when it does not start with them. The speech service
 * may correct a word, so most of them matching is enough. */
export function afterWords(text: string, passed: string): string | null {
  const old = plain(passed).split(' ').filter(Boolean);
  const raw = text.trim().split(/\s+/).filter(Boolean);
  let index = 0, seen = 0, same = 0;
  while (index < raw.length && seen < old.length) {
    const word = plainWord(raw[index]);
    if (word) { if (word === old[seen]) same += 1; seen += 1; }
    index += 1;
  }
  if (!seen || same < Math.ceil(seen * 0.8)) return null;
  return raw.slice(index).join(' ');
}

/** The interviewer spoke. `show` is empty when there is nothing new to put in the box. */
export function hearInterviewer(memory: TalkMemory, text: string, customerHasBox = false): { memory: TalkMemory; show: string } {
  const heard = text.trim();
  // A late copy of what was already heard (the sentence marked finished) does not take the box back.
  if (customerHasBox && plain(heard) === plain(memory.interviewerHeard)) return { memory: { ...memory, interviewerHeard: heard }, show: '' };
  const rest = memory.interviewerPassed ? afterWords(heard, memory.interviewerPassed) : null;
  return {
    memory: { interviewerHeard: heard, interviewerPassed: rest === null ? '' : memory.interviewerPassed, mine: '' },
    show: rest ?? heard,
  };
}

/** The customer spoke. `show` is their whole talk so far; finished sentences are kept for the next words. */
export function hearMe(memory: TalkMemory, text: string, isFinal: boolean): { memory: TalkMemory; show: string } {
  const spoken = text.trim();
  const show = latestWords([memory.mine, spoken].filter(Boolean).join(' '), MAX_MINE);
  return { memory: isFinal && spoken ? { ...memory, mine: show } : memory, show };
}

/** The customer holds the box with `mine`. Once that is a real reply, what the interviewer had said stays out of the
 * box when they speak again; a short "yeah, sure" does not cut the interviewer's question in two. */
export function takeOver(memory: TalkMemory, mine: string): TalkMemory {
  if (!memory.interviewerHeard || mine.split(/\s+/).filter(Boolean).length < REAL_REPLY_WORDS) return memory;
  return { ...memory, interviewerPassed: memory.interviewerHeard };
}

/** Whether speech may flow back into a box that was just sent or cleared. */
export function isNewSpeech(text: string, handled: { text: string; at: number } | null, now: number): boolean {
  const next = plain(text);
  if (!next) return false;
  if (!handled || now - handled.at > HANDLED_MS) return true;
  return !` ${plain(handled.text)} `.includes(` ${next} `);
}
