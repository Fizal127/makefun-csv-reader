// A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
// Same answers, value for value, on every input; written to be fast:
// - Most records are plain: no quote, no stray CR, ending at LF or CRLF.
//   Those are taken in one step: the next of `"`, CR, LF is found with a
//   single native scan, and when it is the line ending the whole record is
//   sliced and split natively, with no per-field work at all.
// - The rest are read field by field, inlined in the record loop: plain
//   fields and quoted fields alike are scanned with tight index loops over
//   char codes and taken as slices (never built a character at a time).
//   Errors are recorded in the same order the reference meets them.
//
// The semantics (csv-reader 1.0.0):
// - A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF, and a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, and each CRLF or lone CR inside it is read as
//   LF; what follows the closing quote, up to the next comma or line break,
//   is appended as it stands (quote_junk, when the field ends); a quote that
//   never closes is a literal character, and the text after it is read again
//   as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it, each padded (short_row, with fields: its count) or
//   cut (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}: line the 1-based line its record starts
//   on, row its record's index in rows (null for the header), in the order met.

const COMMA = 44; // ,
const LF = 10;    // \n
const CR = 13;    // \r
const QUOTE = 34; // "

// The characters that can end a plain record or open a quoted field.
const RE_RECORD = /["\r\n]/g;

// How a field ended.
const END_COMMA = 0;
const END_LINE = 1;
const END_TEXT = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, appending the characters it
  // keeps to `head`. Returns {value, ended, added}: added counts the
  // characters kept from the scan (the quote_junk test needs only > 0).
  // Used only after a closing quote (quote_junk) and for an unterminated
  // quote; the record loop inlines the common case of an empty head.
  function readUnquoted(head) {
    let parts = null; // kept segments, once a stray CR splits the field
    let seg = pos;    // start of the current kept segment
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      // The only characters that can end or split the field are all below 45.
      if (c < 45 && (c === COMMA || c === LF || c === CR)) {
        if (c === CR && text.charCodeAt(i + 1) !== LF) {
          // Stray CR: dropped, error recorded, the field goes on.
          err('stray_cr');
          if (parts === null) parts = [text.slice(seg, i)];
          else parts.push(text.slice(seg, i));
          i++;
          seg = i;
          continue;
        }
        let scanned;
        if (parts === null) scanned = text.slice(seg, i);
        else {
          parts.push(text.slice(seg, i));
          scanned = parts.join('');
        }
        if (c === LF || c === CR) line++;
        pos = c === CR ? i + 2 : i + 1;
        return {
          value: head + scanned,
          ended: c === COMMA ? END_COMMA : END_LINE,
          added: scanned.length,
        };
      }
      i++;
    }
    let scanned;
    if (parts === null) scanned = text.slice(seg, n);
    else {
      parts.push(text.slice(seg, n));
      scanned = parts.join('');
    }
    pos = n;
    return { value: head + scanned, ended: END_TEXT, added: scanned.length };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos++;
        line++;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a plain record holds no quote and no stray CR, so the first
    // of `"`, CR, LF at or after pos is its line ending (or there is none,
    // and the rest of the text is one record). Take it whole and split it.
    let fields = null;
    RE_RECORD.lastIndex = pos;
    const m = RE_RECORD.exec(text);
    if (m === null) {
      fields = text.slice(pos).split(',');
      pos = n;
    } else {
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === LF) {
        fields = text.slice(pos, i).split(',');
        pos = i + 1;
        line++;
      } else if (c === CR && text.charCodeAt(i + 1) === LF) {
        fields = text.slice(pos, i).split(',');
        pos = i + 2;
        line++;
      }
    }
    if (fields === null) {
      // Slow path: the record holds a quote or a stray CR before its end.
      fields = [];
      let ended = END_COMMA;
      let quoted = false;
      while (ended === END_COMMA) {
        if (text.charCodeAt(pos) === QUOTE) {
          quoted = true;
          // Quoted field, inlined: scan to the closing quote ("" is one
          // quote, CRLF and lone CR inside are LF), then what follows it.
          const open = pos;
          const openLine = line;
          let parts = null;
          let seg = pos + 1;
          let i = seg;
          let value = null;
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c < 45 && (c === QUOTE || c === CR || c === LF)) {
              if (c === QUOTE) {
                if (text.charCodeAt(i + 1) === QUOTE) {
                  if (parts === null) parts = [text.slice(seg, i), '"'];
                  else parts.push(text.slice(seg, i), '"');
                  i += 2;
                  seg = i;
                  continue;
                }
                value = parts === null ? text.slice(seg, i) : (parts.push(text.slice(seg, i)), parts.join(''));
                pos = i + 1;
                break;
              }
              if (parts === null) parts = [text.slice(seg, i), '\n'];
              else parts.push(text.slice(seg, i), '\n');
              line++;
              i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
              seg = i;
              continue;
            }
            i++;
          }
          if (value === null) {
            // The quote never closes: a literal character, the text after
            // it read again as an unquoted field.
            pos = open + 1;
            line = openLine;
            err('unterminated_quote');
            const f = readUnquoted('"');
            fields.push(f.value);
            ended = f.ended;
          } else if (pos >= n) {
            fields.push(value);
            ended = END_TEXT;
          } else {
            const d = text.charCodeAt(pos);
            if (d === COMMA) {
              pos++;
              fields.push(value);
              ended = END_COMMA;
            } else if (d === LF) {
              pos++;
              line++;
              fields.push(value);
              ended = END_LINE;
            } else if (d === CR && text.charCodeAt(pos + 1) === LF) {
              pos += 2;
              line++;
              fields.push(value);
              ended = END_LINE;
            } else {
              const junk = readUnquoted(value);
              if (junk.added > 0) err('quote_junk');
              fields.push(junk.value);
              ended = junk.ended;
            }
          }
        } else {
          // Plain field, inlined: scan to the next comma, line break or
          // stray CR and take the field as a slice.
          quoted = false;
          let parts = null;
          let seg = pos;
          let i = pos;
          let scanned = null;
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c < 45 && (c === COMMA || c === LF || c === CR)) {
              if (c === CR && text.charCodeAt(i + 1) !== LF) {
                err('stray_cr');
                if (parts === null) parts = [text.slice(seg, i)];
                else parts.push(text.slice(seg, i));
                i++;
                seg = i;
                continue;
              }
              scanned = parts === null ? text.slice(seg, i) : (parts.push(text.slice(seg, i)), parts.join(''));
              if (c !== COMMA) line++;
              pos = c === CR ? i + 2 : i + 1;
              ended = c === COMMA ? END_COMMA : END_LINE;
              break;
            }
            i++;
          }
          if (scanned === null) {
            scanned = parts === null ? text.slice(seg, n) : (parts.push(text.slice(seg, n)), parts.join(''));
            pos = n;
            ended = END_TEXT;
          }
          fields.push(scanned);
        }
      }
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
