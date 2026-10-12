// Redaction and capture modes. Both run before an event is sealed: the hash
// chain cannot be edited afterwards, so a secret that gets in stays in.
//
// This is pattern matching, not a guarantee. It catches credentials with a
// recognisable shape or name, and where it must guess it redacts: text after
// "password:" goes even when it was not a password. A bare high-entropy
// string with neither shape nor name passes. Use EVENTLOOM_MODE=metadata
// where that is not acceptable.
//
// Every pattern must stay linear on long unbroken input (a base64 blob, a
// hash dump). test/redact.test.mjs checks that by comparing run times at
// two input sizes.

// "token" is listed apart because its plural is usually a count
// (max_tokens, total_tokens), which the others' plurals are not.
const PLURALISABLE_SECRET_WORDS = "secret|password|passwd|passphrase|(?:api|access|secret|private|signing|encryption)[_-]?key";
const SECRET_WORD = `(?:token|${PLURALISABLE_SECRET_WORDS})`;
// The end of a key's or variable's name. Here the plural is as telling as
// the singular, and a few endings that still name the same secret may follow
// (password_confirmation, SECRET_KEY_BASE, password2).
const SECRET_NAME_END = `(?:token|(?:${PLURALISABLE_SECRET_WORDS})s?)(?:[_-]?(?:confirmation|base|\\d{1,2}))?`;
const QUOTES = "\"'`";

// JSON carried inside a string writes its line breaks and tabs as \n, \r and
// \t, so the letter of such an escape can sit directly before a word. Where
// a pattern requires a word or flag to start, that position counts too.
const AFTER_ESCAPE = String.raw`(?<=\\[nrt])`;
const notAfter = (characters) => `(?:(?<![${characters}])|${AFTER_ESCAPE})`;
const WORD_START = `(?:\\b|${AFTER_ESCAPE})`;
const FLAG_START = notAfter("A-Za-z0-9-");
// A run of backslashes inside a regex is always bounded. An open-ended one
// next to another open-ended piece gives the matcher several ways to split a
// long run, and it tries them all. (The hand-written walkers below consume a
// run whole, once, and need no bound.)
const NO_OR_SOME_BACKSLASHES = String.raw`\\{0,64}`;
const SOME_BACKSLASHES = String.raw`\\{1,64}`;
// Space, including a tab written as an escape at any depth (\t, \\t, …).
// (Matched from the start of the run, so that a long run of backslashes is
// not tried again from each backslash in it.)
const SPACE = String.raw`(?:[^\S\n]|(?<!\\)${SOME_BACKSLASHES}t)`;

// NAME= or NAME: and what languages write instead (:=, =>, ==). Between the
// name and the operator may stand what closes the name: a quote (possibly
// backslash-escaped, when JSON is carried inside a string), a backtick, or
// the ] of config["NAME"] and user[NAME]. Spaces around the operator are
// allowed; a line break is not, or a YAML key with nothing after it would
// take the next line for its value.
const ASSIGN = NO_OR_SOME_BACKSLASHES + "[\"'`]?" + String.raw`\]?${SPACE}*(?::=|=>|={1,3}|:)${SPACE}*`;
// After NAME: <type> there may follow = <value> (password: str = "…"). The
// type is redacted as a value first, so nothing depends on recognising it;
// this only finds the = that introduces the second value.
const AFTER_COLON = new RegExp(`:${SPACE}*$`);
const TYPED_ASSIGNMENT = new RegExp(String.raw`(?:${SPACE}+[\w.:<>[\]|?&',]{1,40}){0,3}?${SPACE}*=(?![=>])${SPACE}*`, "y");

// --- Values that follow a name ------------------------------------------------
// Each introducer finds the places where a secret value starts, and says what
// ends that value when it is not quoted. The same reader takes the value for
// all of them. Each introducer gets its own pass over the text, so that none
// can hide a value that belongs to another.

// Is there a line break or tab written as an escape here (\n, \\r, …)?
function isEscapedBreak(text, at) {
  let end = at;
  while (text[end] === "\\") end++;
  return end > at && "nrt".includes(text[end] ?? "-");
}

// What ends an unquoted value: always a space or an escaped line break. In an
// assignment also an & that starts the next query parameter (&state=…); an &
// on its own is part of the value, as in a .env or YAML password.
const endsAssignment = (text, at) => /\s/.test(text[at]) || isEscapedBreak(text, at)
  || (text[at] === "&" && /^&[\w.;%[\]-]{1,64}=/.test(text.slice(at, at + 66)));
const endsShellWord = (text, at) => /[\s;&|]/.test(text[at]) || isEscapedBreak(text, at);
const endsHeaderWord = (text, at) => /[\s,;]/.test(text[at]) || isEscapedBreak(text, at);
const endsLine = (text, at) => isEscapedBreak(text, at);

// A backslash at the end of a line continues it on the next. Written out
// that is \ and a line break; carried in JSON it is an escaped backslash and
// an escaped break, which comes to 3 backslashes and the letter at one level
// of escaping, 6 at two, 12 at three. Returns where the continued text
// starts, or -1 if `at` is not a continuation.
function afterContinuation(text, at) {
  let end = at;
  while (text[end] === "\\") end++;
  const run = end - at;
  let next = -1;
  if (run % 2 === 1 && text[end] === "\n") next = end + 1;
  else if (run % 2 === 1 && text[end] === "\r" && text[end + 1] === "\n") next = end + 2;
  else if (run >= 3 && run % 3 === 0 && Number.isInteger(Math.log2(run / 3)) && "nr".includes(text[end] ?? "-")) {
    next = end + 1;
    // an escaped CRLF: the \r just passed is followed by an escaped \n
    let afterReturn = next;
    while (text[afterReturn] === "\\") afterReturn++;
    if (text[end] === "r" && afterReturn > next && text[afterReturn] === "n") next = afterReturn + 1;
  }
  if (next === -1) return -1;
  while (text[next] === " " || text[next] === "\t") next++;
  return next;
}

// letter'letter is an apostrophe (isn't, O'Brien), not a quote that opens.
function isApostrophe(text, at, escapes) {
  return text[at] === "'" && escapes === 0 && /^[A-Za-z]'[A-Za-z]$/.test(text.slice(at - 1, at + 2));
}

// What can follow the quote that closes a string: the end of the line, a
// space, a separator, a closing bracket, the quote of a string around it, or
// the full stop of the sentence it was quoted in.
const AFTER_QUOTE_CHARACTERS = String.raw`\s,;:)}\]&|>"'` + "`";
const AFTER_QUOTE_SENTENCE_END = String.raw`[.!?](?:\s|$)`;

// A backtick or an escaped quote directly after a flag that, by what follows
// it, closes a string the command sits in (`… | sort -u`): the flag then has
// no value here. For a plain " or ' the command finder knows which quote is
// open and decides by that.
const FOLLOWS_CLOSING_QUOTE = String.raw`(?:$|[${AFTER_QUOTE_CHARACTERS}]|${AFTER_QUOTE_SENTENCE_END}|${SOME_BACKSLASHES}[nr"'` + "`])";
const CLOSING_QUOTE_AHEAD = "(?:`|" + SOME_BACKSLASHES + "[\"'`])" + FOLLOWS_CLOSING_QUOTE;
// After a space only a backtick is read this way. An escaped quote there is
// more often the opening of the value (curl -u \":token\"), and taking it for
// a closing one would let the value through.
const CLOSING_BACKTICK_AHEAD = "`" + FOLLOWS_CLOSING_QUOTE;

// How far past its own line a command is followed while a quote stands open.
const OPEN_QUOTE_REACH = 4000;

// Does the line that ends at `lineEnd` end in a backslash (before LF or CRLF)?
// Any number of them counts: in a script that was escaped once more to sit
// inside a quoted string, a continuation is written as two.
function endsInContinuation(text, lineEnd) {
  const lastChar = text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
  return backslashesBefore(text, lastChar) > 0;
}

// Where the values of a command's flag start, e.g. the user:password after
// curl -u; `subcommand`, if given, must come first (docker … login … -p).
//
// One pass over the text, with no attempt to parse the shell: each earlier
// attempt at that either hid a flag or ran away on odd input. Seeing the
// command's name switches the search for the flag on, and it goes off again
//  - at a ; & | followed by a space, if no quote at all has been seen since;
//  - at the end of the line, unless the line ends in a continuation or a
//    quote stands open (for a bounded distance);
//  - at an escaped line break in JSON-carried text, unless it is a
//    continuation or a quote has been seen since the command.
// Quotes are followed as they open and close but never looked ahead for. The
// rules lean towards leaving the search on, which costs some over-redaction
// (the value after a later, unrelated -u). It can still be switched off too
// early by a quote that prose left open and a later one closed; the README
// says how far a command is followed.
function flagValueStarts({ command, subcommand, flag }) {
  const eitherCase = (words) => words.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
  const beforeWord = String.raw`(?:(?<=\s)|${AFTER_ESCAPE})`;
  const events = new RegExp([
    // names in either case (Curl at the start of a sentence); flags are not,
    // since -u and -U are different flags
    `(?<command>${WORD_START}(?:${eitherCase(command)})\\b)`,
    `(?<subcommand>${beforeWord}${subcommand ? eitherCase(subcommand) : "(?!)"}(?=\\s))`,
    `(?<flag>${beforeWord}(?:${flag}))`,
    String.raw`(?<quote>["'])`,
    String.raw`(?<separator>[;&|](?=\s|$))`,
    // an escaped CRLF is one break, not two
    String.raw`(?<escapedBreak>(?<!\\)(?:(?:${SOME_BACKSLASHES}r)?${SOME_BACKSLASHES}n|${SOME_BACKSLASHES}r))`,
    String.raw`(?<lineEnd>\n)`,
  ].join("|"), "g");

  return (text) => {
    const starts = [];
    let searching = false;
    let subcommandSeen = false;
    let since = 0;
    let quotesSeen = false; // while searching
    // The quote character standing open, if any. Followed from the start of
    // each line, searching or not, so that it is right when a command begins
    // inside a string or after one.
    let openQuote = null;
    const stop = () => {
      searching = false;
      quotesSeen = false;
    };
    for (const event of text.matchAll(events)) {
      const { groups } = event;
      if (groups.quote !== undefined) {
        if (searching) quotesSeen = true;
        // an escaped quote and an apostrophe (curl's, didn't) open nothing
        if (backslashesBefore(text, event.index) % 2 === 1 || isApostrophe(text, event.index, 0)) continue;
        // the other quote character is ordinary text inside an open string
        if (openQuote === null) openQuote = groups.quote;
        else if (openQuote === groups.quote) openQuote = null;
      } else if (groups.command !== undefined) {
        // The name also comes up inside the command it started (docker login
        // docker.io), so what has been seen of that command is kept.
        since = event.index;
        if (searching) continue;
        searching = true;
        subcommandSeen = subcommand === undefined;
      } else if (groups.lineEnd !== undefined || groups.escapedBreak !== undefined) {
        const isEscaped = groups.escapedBreak !== undefined;
        const continues = isEscaped ? afterContinuation(text, event.index) !== -1 : endsInContinuation(text, event.index);
        // in JSON-carried text quotes are escaped and tell nothing about lines
        const insideQuote = isEscaped ? quotesSeen : openQuote !== null && event.index - since < OPEN_QUOTE_REACH;
        if (searching && (continues || insideQuote)) continue;
        stop();
        if (!isEscaped) openQuote = null;
      } else if (!searching) {
        continue;
      } else if (groups.subcommand !== undefined) {
        subcommandSeen = true;
      } else if (groups.flag !== undefined) {
        // "… | sort -u" and $(… | sort -u): what follows closes the string or
        // the substitution the command sits in, so the flag has no value. A
        // quote counts as closing only if one is open and it also looks the
        // part; the state alone can be wrong after an apostrophe (admins').
        const valueStart = event.index + event[0].length;
        const closesEnclosure = text[valueStart] === ")" || (openQuote !== null && text[valueStart] === openQuote
          && AFTER_CLOSING_QUOTE.test(text.slice(valueStart + 1, valueStart + 3)));
        if (subcommandSeen && !closesEnclosure) starts.push(valueStart);
      } else if (!quotesSeen) {
        stop(); // a separator, with no quote since the command that it could be inside
      }
    }
    return starts;
  };
}

// Where each match of `pattern` ends, which is where its value starts.
const afterEach = (pattern) => (text) => Array.from(text.matchAll(new RegExp(pattern, "gi")), (match) => match.index + match[0].length);

const INTRODUCERS = [
  // Authorization: <scheme> <credentials>. The scheme is kept; with none,
  // the single token is the credential.
  { starts: afterEach(`authorization${ASSIGN}`), ends: endsHeaderWord, keepsScheme: true },
  // The secret word must stand directly before the operator, whatever
  // precedes it: AWS_SECRET_ACCESS_KEY= and client-secret: match, max_tokens=
  // does not.
  { starts: afterEach(`${SECRET_NAME_END}${ASSIGN}`), ends: endsAssignment, mayBeTyped: true },
  // cookie: "value" as a quoted field. (A Cookie header line is a pattern below.)
  { starts: afterEach(`cookie${ASSIGN}(?=${NO_OR_SOME_BACKSLASHES}[${QUOTES}])`), ends: endsAssignment },
  { starts: afterEach(`${FLAG_START}--[a-z0-9_-]{0,40}?${SECRET_NAME_END}${SPACE}+(?!-)`), ends: endsShellWord },
  {
    starts: flagValueStarts({
      command: "curl|wget",
      // -u, or a cluster of short flags that take no argument ending in it
      // (-sSu); --user, --proxy-user
      flag: String.raw`-[fgiIjJkLlnNOpqRsSvVZa#0-9]*u(?!${CLOSING_QUOTE_AHEAD})${SPACE}*(?!${CLOSING_BACKTICK_AHEAD})|--(?:proxy-)?user(?:=|${SPACE}+)`,
    }),
    ends: endsShellWord,
  },
  {
    starts: flagValueStarts({
      command: "docker|podman|helm|oc|az",
      subcommand: "login",
      flag: String.raw`-p(?!${CLOSING_QUOTE_AHEAD})${SPACE}*(?!${CLOSING_BACKTICK_AHEAD})(?=\S)`,
    }),
    ends: endsShellWord,
  },
];
// A scheme is a word of letters and hyphens; the two families with digits in
// their names are listed, so that a bare credential is not taken for one.
const SCHEME = new RegExp(String.raw`(?:[A-Za-z][A-Za-z-]{1,31}|AWS4-HMAC-SHA256|SCRAM-SHA-(?:1|256|512)(?:-PLUS)?)${SPACE}+(?=\S)`, "y");
// name=value, as opposed to a token that merely ends in = padding
const AUTH_PARAMETER = /^[A-Za-z_][\w-]*[ \t]*=[ \t]*[^=\s,;]/;
// a JSON literal that is not a string, standing where a value would
// (what follows must be the end of the object or the next key, so that a
// password such as 2024,Summer is not cut at its comma)
const BARE_JSON_LITERAL = /(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*(?:[}\]](?!\w)|,\s*\\{0,64}["']))/y;
const OPENING_QUOTE = new RegExp(`(\\\\*)([${QUOTES}])`, "y");

// Counted up to a limit: nothing is escaped more deeply than a few levels,
// and this is asked again for every quote on a line, unlike the walkers'
// own passage over a run.
const MAX_ESCAPES = 64;

function backslashesBefore(text, index) {
  let count = 0;
  while (count < MAX_ESCAPES && text[index - count - 1] === "\\") count++;
  return count;
}

// Does a quote preceded by `found` backslashes close a string that was opened
// by a quote preceded by `opened` backslashes? Unescaped text (opened = 0)
// closes on an even count; one level of JSON escaping (opened = 1) closes on
// \" but not on \\\", which is a quote inside the value; and so on, the
// period doubling with each level. A quote escaped less than the opener
// closes too: the text was cut or mixed, and stopping early would leak.
function closesString(found, opened) {
  return found <= opened || found % (2 * (opened + 1)) === opened;
}

// Finds line ends and quotes in `text`. Reading mostly moves left to right, so
// an answer is remembered together with the position it was found from, and
// reused for any position between the two.
function scannerFor(text) {
  let knownLine = { from: 0, end: -1 };
  // per quote character: the first one at or after `from`
  const knownQuote = Object.fromEntries([...QUOTES].map((quote) => [quote, { from: 0, at: -1 }]));
  const indexFrom = (needle, from) => {
    const found = text.indexOf(needle, from);
    return found === -1 ? text.length : found;
  };
  const lineEnd = (from) => {
    if (from < knownLine.from || knownLine.end < from) knownLine = { from, end: indexFrom("\n", from) };
    return knownLine.end;
  };
  return {
    lineEnd,
    // Where the string opened by `quote` (after `opened` backslashes) closes,
    // looking from `from`; the end of the line if it does not close on it.
    closingQuote(quote, opened, from) {
      const end = lineEnd(from);
      const known = knownQuote[quote];
      if (from < known.from || known.at < from) knownQuote[quote] = { from, at: indexFrom(quote, from) };
      let { at } = knownQuote[quote];
      while (at < end && !closesString(backslashesBefore(text, at), opened)) at = indexFrom(quote, at + 1);
      return Math.min(at, end);
    },
  };
}

// The same test from inside a value, on the two characters after a quote. Any
// backslash counts here: it belongs to a quote or break that closes further out.
const AFTER_CLOSING_QUOTE = new RegExp(String.raw`^(?:$|[${AFTER_QUOTE_CHARACTERS}\\]|${AFTER_QUOTE_SENTENCE_END})`);

// Where the {…} or […] opened at `start` closes, counting nested brackets and
// stepping over strings; the end of the line if it does not close on it.
function endOfBracketed(text, start, lineEnd, scanner) {
  let depth = 0;
  let at = start;
  while (at < lineEnd) {
    let afterBackslashes = at;
    while (text[afterBackslashes] === "\\") afterBackslashes++;
    const char = text[afterBackslashes];
    if (afterBackslashes < lineEnd && QUOTES.includes(char)) {
      const closing = scanner.closingQuote(char, afterBackslashes - at, afterBackslashes + 1);
      at = closing < lineEnd ? closing + 1 : afterBackslashes + 1;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    at = afterBackslashes + 1;
    if (depth === 0) return Math.min(at, lineEnd);
  }
  return lineEnd;
}

// The extent of the value starting at `start`: the inside of a quoted string,
// a JSON literal, a bracketed JSON value, or one unquoted word.
function readValue(text, valueStart, ends, scanner) {
  // a value may begin on the next line: --password \⏎ value
  const continued = afterContinuation(text, valueStart);
  const start = continued === -1 ? valueStart : continued;
  const lineEnd = scanner.lineEnd(start);
  OPENING_QUOTE.lastIndex = start;
  const opening = OPENING_QUOTE.exec(text);
  if (opening) {
    const [, escapes, quote] = opening;
    const from = OPENING_QUOTE.lastIndex;
    let closing = scanner.closingQuote(quote, escapes.length, from);
    // '' inside a quoted value is a literal quote in YAML, SQL and shell
    while (escapes.length === 0 && closing < lineEnd && text[closing + 1] === quote) {
      closing = scanner.closingQuote(quote, 0, closing + 2);
    }
    // A shell word can go on after the quoted part, as in "$BASE"suffix: then
    // the whole word is the value, read as an unquoted one from where it began.
    const wordGoesOn = closing < lineEnd && /^[^\s"'`\\]/.test(text[closing + 1] ?? "")
      && !ends(text, closing + 1) && !AFTER_CLOSING_QUOTE.test(text.slice(closing + 1, closing + 3));
    if (!wordGoesOn) {
      // the closing quote's own backslashes stay with it
      const to = closing < lineEnd ? closing - Math.min(escapes.length, backslashesBefore(text, closing)) : lineEnd;
      return { from, to: Math.max(from, to), quoted: true };
    }
  }

  // null, true, false or a number in compact JSON is the whole value; reading
  // on to the next space would take the fields after it.
  BARE_JSON_LITERAL.lastIndex = start;
  const literal = BARE_JSON_LITERAL.exec(text);
  if (literal) return { from: start, to: BARE_JSON_LITERAL.lastIndex, quoted: false };

  // An object or array in compact JSON is the value as a whole. (A marker an
  // earlier pattern left, [REDACTED_…], is the start of an ordinary word.)
  // If more of a word follows the closing bracket, as in [kT9]mQ2xP, it was
  // not JSON: the word reader below carries on from the bracket, so that
  // nothing is read twice.
  let wordFrom = start;
  if (text[start] === "{" || (text[start] === "[" && !text.startsWith("[REDACTED", start))) {
    const to = endOfBracketed(text, start, lineEnd, scanner);
    if (to >= lineEnd || ends(text, to) || /[,}\]"'`\\]/.test(text[to])) return { from: start, to, quoted: false };
    wordFrom = to;
  }

  // An unquoted word runs to the next character that `ends` it. A quote met
  // on the way is judged by what follows it:
  //  - something that can follow a closing quote: the word sat inside a
  //    string, as in 'https://x/?token=abc', and stops here;
  //  - otherwise, with a partner later on the line, it opens a quoted part of
  //    the word, as in abc"def ghi", and the word continues past the partner;
  //  - otherwise it is a stray character and part of the word, as is an
  //    apostrophe between two letters.
  let at = wordFrom;
  while (at < lineEnd && !ends(text, at)) {
    let quoteAt = at;
    while (text[quoteAt] === "\\") quoteAt++;
    const escapes = quoteAt - at;
    if (quoteAt >= lineEnd || !QUOTES.includes(text[quoteAt])) {
      // Plain text. Step over the whole run of backslashes at once, and over
      // the next character too when it is plain or an odd backslash escapes it.
      const takesNext = escapes === 0 || escapes % 2 === 1;
      at = Math.min(quoteAt + (takesNext ? 1 : 0), lineEnd);
      continue;
    }
    if (at > start && AFTER_CLOSING_QUOTE.test(text.slice(quoteAt + 1, quoteAt + 3))) break;
    if (isApostrophe(text, quoteAt, escapes)) {
      at = quoteAt + 1;
      continue;
    }
    const closing = scanner.closingQuote(text[quoteAt], escapes, quoteAt + 1);
    at = closing < lineEnd ? closing + 1 : quoteAt + 1;
  }
  return { from: start, to: Math.min(at, lineEnd), quoted: false };
}

// The credential part of an Authorization value: everything after the scheme
// word, if there is one. Schemes that take a list of parameters (Digest,
// AWS4-HMAC-SHA256, OAuth) carry the secret in a later one, so for those the
// whole list goes, to the end of the line or of the string it sits in.
function withoutScheme(text, value, scanner) {
  SCHEME.lastIndex = value.from;
  const scheme = SCHEME.exec(text);
  if (!scheme) return value;
  const from = value.from + scheme[0].length;
  if (value.quoted) return { ...value, from: Math.min(from, value.to) };
  const word = readValue(text, from, endsHeaderWord, scanner);
  const isParameterList = AUTH_PARAMETER.test(text.slice(word.from, word.from + 120));
  return isParameterList ? readValue(text, from, endsLine, scanner) : word;
}

function redactValuesAfter({ starts, ends, keepsScheme = false, mayBeTyped = false }, text) {
  const scanner = scannerFor(text);
  let clean = "";
  let copiedTo = 0;
  let readTo = 0;
  const redactValueAt = (start) => {
    let value = readValue(text, start, ends, scanner);
    if (keepsScheme) value = withoutScheme(text, value, scanner);
    // a value an earlier pattern replaced whole keeps its more specific marker
    const alreadyRedacted = /^\[REDACTED[A-Z_]*\]$/.test(text.slice(value.from, value.to));
    if ((value.quoted || value.to > value.from) && !alreadyRedacted) {
      clean += `${text.slice(copiedTo, value.from)}[REDACTED]`;
      copiedTo = value.to;
    }
    readTo = Math.max(start, value.to);
  };
  for (const start of starts(text)) {
    if (start < readTo) continue; // lies inside the value just read
    redactValueAt(start);
    // only NAME: type = value has a type; after NAME= the next = is another name's
    if (!mayBeTyped || !AFTER_COLON.test(text.slice(Math.max(0, start - 80), start))) continue;
    TYPED_ASSIGNMENT.lastIndex = readTo;
    if (TYPED_ASSIGNMENT.test(text)) redactValueAt(TYPED_ASSIGNMENT.lastIndex);
  }
  return clean + text.slice(copiedTo);
}

function redactIntroducedValues(text) {
  return INTRODUCERS.reduce((clean, introducer) => redactValuesAfter(introducer, clean), text);
}

// --- Credentials recognisable by shape -----------------------------------------
// Applied in order; each entry is [pattern, replacement] or a function.
const shape = (source, flags = "g") => new RegExp(source, flags);

const TEXT_PATTERNS = [
  // PEM, and PGP's armoured "PRIVATE KEY BLOCK"
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, "[REDACTED_PEM]"],
  // The header segment is bounded: unbounded, input such as "eyJ-eyJ-…" would
  // be rescanned from every "eyJ" in it.
  [shape(notAfter("A-Za-z0-9") + String.raw`eyJ[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`), "[REDACTED_JWT]"],
  // sk-… / pk-… keys: one unbroken run of 16+ after the dashed prefix, which a
  // hyphenated word such as sk-learn-experiments does not have.
  [shape(WORD_START + String.raw`(?:sk|pk)-(?:[A-Za-z0-9_]{1,24}-){0,4}[A-Za-z0-9_]{16,}[A-Za-z0-9_-]*`), "[REDACTED_KEY]"],
  [shape(WORD_START + String.raw`(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b`), "[REDACTED_KEY]"],
  [shape(WORD_START + String.raw`(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{16,})\b`), "[REDACTED_GH]"],
  [shape(WORD_START + String.raw`(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}\b`), "[REDACTED_SLACK]"],
  [shape(WORD_START + String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}\b`), "[REDACTED_AWS]"],
  [shape(WORD_START + String.raw`AIza[0-9A-Za-z_-]{20,}\b`), "[REDACTED_GOOGLE]"],
  [shape(WORD_START + String.raw`npm_[A-Za-z0-9]{16,}\b`), "[REDACTED_NPM]"],
  // scheme://user:password@host — up to the last @ of the authority
  // (the user may be empty, as in redis://:password@host)
  [shape(notAfter("A-Za-z0-9+.-") + String.raw`([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@?#]{0,256}:[^/\s?#]{1,256}@`, "gi"), "$1[REDACTED]@"],
  // "Bearer <token>" on its own; the digit keeps prose such as "Bearer bonds" out
  [shape(WORD_START + String.raw`(Bearer)\s+(?=[A-Za-z0-9._~+/=-]{0,512}\d)[A-Za-z0-9._~+/=-]{20,}`, "gi"), "$1 [REDACTED]"],
  redactIntroducedValues,
  [shape(`${WORD_START}(${SECRET_WORD}\\s+(?:is|was)\\s+)[^\\s"'\`\\\\]{4,}`, "gi"), "$1[REDACTED]"],
  // A Cookie or Set-Cookie header line. The "=" tells a header from code such
  // as `cookie: req.cookie`; cookie values may hold quotes and commas, so the
  // rest of the line goes, up to a real or escaped line break.
  [shape(FLAG_START + String.raw`((?:set-)?cookie[^\S\n]*:[^\S\n]*)(?![^\S\n]|${NO_OR_SOME_BACKSLASHES}["'` + "`" + String.raw`]?\[REDACTED)(?=[^\n=]{0,256}=)(?:(?!${SOME_BACKSLASHES}[rn])[^\n])+`, "gi"), "$1[REDACTED]"],
];

// Structured payloads hold the name and the value in separate strings, so the
// NAME=value patterns never see them together. The key decides instead.
// Plurals count too (passwords, api_keys, cookies), and trailing brackets
// allow form field names such as user[password] and creds[secret][].
const SECRET_KEY = new RegExp(`(?:${SECRET_NAME_END}|(?:credential|cookie|authorization)s?)(?:\\]|\\[\\])*$`, "i");

export function redactString(text) {
  let clean = text;
  for (const step of TEXT_PATTERNS) {
    clean = typeof step === "function" ? step(clean) : clean.replace(step[0], step[1]);
  }
  return clean;
}

// Under a secret-named key every string and number is replaced, however
// deeply nested. Booleans and null carry no secret and keep their meaning.
export function redact(value, underSecretKey = false) {
  if (typeof value === "string") return underSecretKey ? "[REDACTED]" : redactString(value);
  if (typeof value === "number" || typeof value === "bigint") return underSecretKey ? "[REDACTED]" : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, underSecretKey));
  if (value && typeof value === "object") {
    // fromEntries defines own properties, so a "__proto__" key is redacted
    // like any other instead of vanishing here
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactString(key),
      redact(item, underSecretKey || SECRET_KEY.test(key)),
    ]));
  }
  return value;
}

const CAPTURE_MODES = ["full", "summary", "metadata"];
const EXCERPT_LENGTH = 200;

// Fields that describe an event without quoting what the agent read or wrote.
const METADATA_FIELDS = [
  "session_id", "correlation_id", "occurred_at", "cwd", "host", "omarchy",
  "git_branch", "git_commit", "git_dirty", "tool", "model", "duration_ms",
  "reason", "source",
];

export function captureMode(env = process.env) {
  const mode = (env.EVENTLOOM_MODE || "full").toLowerCase();
  if (!CAPTURE_MODES.includes(mode)) {
    throw new Error(`EVENTLOOM_MODE must be one of ${CAPTURE_MODES.join(", ")} (got "${env.EVENTLOOM_MODE}")`);
  }
  return mode;
}

function excerpt(text) {
  if (text.length <= EXCERPT_LENGTH) return text;
  let cut = text.slice(0, EXCERPT_LENGTH);
  // do not leave half of a surrogate pair behind
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function excerptStrings(value) {
  if (typeof value === "string") return excerpt(value);
  if (Array.isArray(value)) return value.map(excerptStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, excerptStrings(item)]));
  }
  return value;
}

function metadataOnly(payload) {
  const kept = {};
  for (const field of METADATA_FIELDS) {
    const value = payload[field];
    // scalars only: an object under an allowed name could carry anything
    if (["string", "number", "boolean"].includes(typeof value)) kept[field] = value;
  }
  return kept;
}

export function applyCaptureMode(payload, mode = captureMode()) {
  if (mode === "metadata") return redact(metadataOnly(payload));
  const clean = redact(payload);
  return mode === "summary" ? excerptStrings(clean) : clean;
}
