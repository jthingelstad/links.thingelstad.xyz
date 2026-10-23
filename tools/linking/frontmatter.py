"""YAML front matter, read with the standard library only.

PyYAML is not guaranteed on the machines that run these tools, so this module
reads the block-style subset of YAML that front matter uses:

- block mappings and block sequences, nested by indentation, including a
  sequence at the same indentation as its key (`links:` then `- text: ...`);
- plain scalars, single-quoted scalars ('' is a quote), double-quoted scalars
  (with YAML's backslash escapes), each possibly folded over several lines;
- literal (|) and folded (>) block scalars with chomping and indentation
  indicators;
- flow sequences of scalars on one line ([], [a, 'b']) and the empty flow
  mapping {};
- comments, blank lines, and a leading byte order mark.

Plain scalars come back as strings, never as numbers or booleans: `number: 350`
is "350" and the caller decides what it means. The plain values null, Null,
NULL, ~ and an empty value come back as None. Anchors, aliases, tags, complex
keys, non-empty flow mappings, nested flow collections, duplicate keys and tab
indentation are refused with a FrontMatterError naming the line, never guessed.
"""

import re

NULLS = frozenset({"", "~", "null", "Null", "NULL"})

_SIMPLE_ESCAPES = {
    "0": "\0",
    "a": "\a",
    "b": "\b",
    "t": "\t",
    "\t": "\t",
    "n": "\n",
    "v": "\v",
    "f": "\f",
    "r": "\r",
    "e": "\x1b",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "N": "\x85",
    "_": "\xa0",
    "L": "\u2028",
    "P": "\u2029",
}
_HEX_ESCAPES = {"x": 2, "u": 4, "U": 8}
_BLOCK_HEADER = re.compile(r"([|>])(?:([1-9])([+-]?)|([+-])([1-9]?)|)\s*(?:#.*)?")
_KEY_COLON = re.compile(r":(?:[ \t]|$)")
_RESERVED_START = "&*!%@`|>"
_HEX_DIGITS = re.compile(r"[0-9A-Fa-f]+")
_FLOW_PLAIN = re.compile(r"[^,\]]*")


class FrontMatterError(ValueError):
    def __init__(self, message, line=None):
        self.line = line
        super().__init__(f"line {line}: {message}" if line else message)


def split_front_matter(text):
    """Return (front matter text, line number of its first line).

    The file must open with a line `---`; the front matter ends at the next
    line that is `---` or `...`.
    """
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.replace("\r\n", "\n").split("\n")
    if lines[0].rstrip() != "---":
        raise FrontMatterError("no front matter: the file does not open with ---", 1)
    for index in range(1, len(lines)):
        if lines[index].rstrip() in ("---", "..."):
            return "\n".join(lines[1:index]), 2
    raise FrontMatterError("the front matter is never closed with ---", 1)


def parse(text, first_line=1):
    """Parse YAML text (the subset above) whose top level is a mapping."""
    return _Parser(text, first_line).document()


def parse_front_matter(text):
    """Split a Markdown file's front matter off and parse it."""
    yaml_text, first_line = split_front_matter(text)
    return parse(yaml_text, first_line)


def _is_sequence_entry(content):
    return content == "-" or content.startswith("- ")


def _cut_comment(text):
    """Drop a trailing comment from a plain scalar: # after a space or a tab."""
    match = re.search(r"[ \t]#", text)
    return text[: match.start()] if match else text


def _plain_value(text):
    text = text.strip()
    return None if text in NULLS else text


class _Parser:
    def __init__(self, text, first_line):
        self.lines = text.split("\n")
        # A document marker at the start of a line ends the document, even
        # inside a block scalar.
        for index, line in enumerate(self.lines):
            if re.fullmatch(r"(?:---|\.\.\.)(?:[ \t].*)?", line):
                self.lines = self.lines[:index]
                break
        self.first_line = first_line
        self.i = 0

    # Positions and errors

    def error(self, message, index=None):
        return FrontMatterError(message, self.first_line + (self.i if index is None else index))

    def indent(self, index):
        line = self.lines[index]
        stripped = line.lstrip(" ")
        if stripped.startswith("\t"):
            raise self.error("a tab in indentation", index)
        return len(line) - len(stripped)

    def at_end(self):
        return self.i >= len(self.lines)

    def skip_blank(self):
        """Move past blank lines and full-line comments."""
        while not self.at_end():
            stripped = self.lines[self.i].strip()
            if stripped and not stripped.startswith("#"):
                return
            self.i += 1

    # Structure

    def document(self):
        self.skip_blank()
        if self.at_end():
            return {}
        if self.indent(self.i) != 0:
            raise self.error("the top level must not be indented")
        node = self.block(0, -1)
        self.skip_blank()
        if not self.at_end():
            raise self.error("unexpected content")
        if not isinstance(node, dict):
            raise self.error("the front matter is not a mapping", 0)
        return node

    def block(self, indent, parent_indent):
        """A node that starts on the current line, at this indent."""
        content = self.lines[self.i][indent:]
        if _is_sequence_entry(content):
            return self.sequence(indent)
        if self.key_split(content) is not None:
            return self.mapping(indent)
        return self.value(content, parent_indent)

    def mapping(self, indent):
        result = {}
        while True:
            self.skip_blank()
            if self.at_end():
                return result
            current = self.indent(self.i)
            if current < indent:
                return result
            if current > indent:
                raise self.error("unexpected indentation")
            content = self.lines[self.i][indent:]
            if _is_sequence_entry(content):
                return result
            split = self.key_split(content)
            if split is None:
                raise self.error("expected 'key: value'")
            key, rest = split
            if key in result:
                raise self.error(f"duplicate key {key!r}")
            result[key] = self.after_indicator(rest, indent, same_indent_sequence=True)

    def sequence(self, indent):
        items = []
        while True:
            self.skip_blank()
            if self.at_end():
                return items
            current = self.indent(self.i)
            if current < indent:
                return items
            if current > indent:
                raise self.error("unexpected indentation")
            content = self.lines[self.i][indent:]
            if not _is_sequence_entry(content):
                return items
            after = content[1:]
            stripped = after.lstrip(" ")
            column = indent + 1 + len(after) - len(stripped)
            if _is_sequence_entry(stripped) or self.key_split(stripped) is not None:
                # A mapping or a list that starts on the entry's own line: read
                # the line again as if the "- " were indentation.
                self.lines[self.i] = " " * column + stripped
                items.append(self.block(column, indent))
            else:
                items.append(self.after_indicator(stripped, indent, same_indent_sequence=False))

    def key_split(self, content):
        """(key, rest of the line) when content is a mapping entry, else None."""
        if not content or content.startswith("#"):
            return None
        if content[0] in "'\"":
            try:
                key, end = self.quoted_on_line(content)
            except FrontMatterError:
                return None
            match = re.match(r"[ \t]*:(?:[ \t]|$)", content[end:])
            if not match:
                return None
            return key, content[end + match.end() :]
        if content[0] in "[{" or content[0] in _RESERVED_START:
            return None
        if content.startswith("? ") or content == "?":
            raise self.error("complex keys are not supported")
        match = _KEY_COLON.search(content)
        if not match:
            return None
        key = content[: match.start()].rstrip()
        if not key or re.search(r"[ \t]#", key):
            return None
        return key, content[match.end() :]

    # Values

    def after_indicator(self, rest, parent_indent, same_indent_sequence):
        """The value after "key:" or "- " on the current line; consumes its lines."""
        rest = rest.strip(" \t")
        if rest and not rest.startswith("#"):
            return self.value(rest, parent_indent)
        self.i += 1
        self.skip_blank()
        if self.at_end():
            return None
        current = self.indent(self.i)
        if current > parent_indent:
            return self.block(current, parent_indent)
        content = self.lines[self.i][current:]
        if same_indent_sequence and current == parent_indent and _is_sequence_entry(content):
            return self.sequence(current)
        return None

    def value(self, text, parent_indent):
        """A scalar or flow collection that starts with text on the current line."""
        first = text[0]
        if first in "|>":
            return self.block_scalar(text, parent_indent)
        if first in "'\"":
            return self.quoted(text)
        if first in "[{":
            return self.flow(text)
        if first in _RESERVED_START:
            raise self.error(f"{first!r} (an anchor, alias, tag or reserved indicator) is not supported")
        if _is_sequence_entry(text):
            raise self.error("a list cannot start on the same line as its key")
        return self.plain(text, parent_indent)

    def plain(self, text, parent_indent):
        value = _cut_comment(text).rstrip()
        commented = value != text.rstrip()
        if _KEY_COLON.search(value):
            raise self.error("': ' inside a plain value (quote it, or fix the indentation)")
        self.i += 1
        blanks = 0
        while not commented and not self.at_end():
            line = self.lines[self.i]
            if not line.strip():
                blanks += 1
                self.i += 1
                continue
            if self.indent(self.i) <= parent_indent or line.strip().startswith("#"):
                break
            piece = _cut_comment(line.strip())
            commented = piece != line.strip()
            piece = piece.rstrip()
            if _KEY_COLON.search(piece):
                raise self.error("': ' inside a plain value (quote it, or fix the indentation)")
            value += ("\n" * blanks if blanks else " ") + piece
            blanks = 0
            self.i += 1
        return _plain_value(value)

    def quoted_on_line(self, text):
        """A quoted scalar that closes on this line: (value, index after the quote)."""
        value, end, state = self.scan_quoted(text, text[0], start=1)
        if state != "closed":
            raise self.error("unterminated quoted scalar")
        return value, end

    def scan_quoted(self, text, quote, start):
        """Scan text from start for the closing quote.

        Returns (value, end, state). state is "closed" (end is the index after
        the closing quote), "open" (the line ended inside the scalar) or
        "escaped_break" (a double-quoted line ended with a backslash).
        """
        out = []
        j = start
        while j < len(text):
            char = text[j]
            if quote == "'":
                if char == "'":
                    if j + 1 < len(text) and text[j + 1] == "'":
                        out.append("'")
                        j += 2
                        continue
                    return "".join(out), j + 1, "closed"
                out.append(char)
                j += 1
                continue
            if char == '"':
                return "".join(out), j + 1, "closed"
            if char == "\\":
                if j + 1 >= len(text):
                    return "".join(out), len(text), "escaped_break"
                code = text[j + 1]
                if code in _SIMPLE_ESCAPES:
                    out.append(_SIMPLE_ESCAPES[code])
                    j += 2
                    continue
                if code in _HEX_ESCAPES:
                    width = _HEX_ESCAPES[code]
                    digits = text[j + 2 : j + 2 + width]
                    if len(digits) != width or not _HEX_DIGITS.fullmatch(digits):
                        raise self.error(f"bad escape \\{code}{digits}")
                    out.append(chr(int(digits, 16)))
                    j += 2 + width
                    continue
                raise self.error(f"unknown escape \\{code}")
            out.append(char)
            j += 1
        return "".join(out), len(text), "open"

    def quoted(self, text):
        quote = text[0]
        opened = self.i
        pieces = []
        line_text = text
        start = 1
        while True:
            value, end, state = self.scan_quoted(line_text, quote, start)
            if state == "closed":
                pieces.append(value)
                trailing = line_text[end:]
                if trailing.strip() and not re.match(r"[ \t]+#", trailing):
                    raise self.error("unexpected text after a quoted scalar")
                self.i += 1
                return "".join(pieces)
            # The scalar continues on the next line: trailing white space goes,
            # and the line break folds to a space (or to newlines, one per
            # blank line); an escaped break joins the lines directly.
            pieces.append(value if state == "escaped_break" else value.rstrip(" \t"))
            self.i += 1
            blanks = 0
            while not self.at_end() and not self.lines[self.i].strip():
                blanks += 1
                self.i += 1
            if self.at_end():
                raise self.error("unterminated quoted scalar", opened)
            if blanks:
                pieces.append("\n" * blanks)
            elif state != "escaped_break":
                pieces.append(" ")
            line_text = self.lines[self.i].lstrip(" \t")
            start = 0

    def block_scalar(self, header, parent_indent):
        match = _BLOCK_HEADER.fullmatch(header.strip())
        if not match:
            raise self.error(f"bad block scalar header {header.strip()!r}")
        style = match.group(1)
        explicit = match.group(2) or match.group(5)
        chomp = match.group(3) or match.group(4) or ""
        block_indent = max(parent_indent, 0) + int(explicit) if explicit else None
        self.i += 1
        lines = []
        while not self.at_end():
            line = self.lines[self.i]
            if not line.strip():
                lines.append(line[block_indent:] if block_indent and len(line) > block_indent else "")
                self.i += 1
                continue
            current = len(line) - len(line.lstrip(" "))
            if block_indent is None:
                if current <= parent_indent:
                    break
                block_indent = current
            if current < block_indent:
                break
            lines.append(line[block_indent:])
            self.i += 1
        trailing = 0
        while lines and not lines[-1].strip():
            lines.pop()
            trailing += 1
        if style == "|":
            body = "\n".join(lines)
        else:
            body = _fold_lines(lines)
        if not lines:
            return "\n" * trailing if chomp == "+" else ""
        if chomp == "-":
            return body
        if chomp == "+":
            return body + "\n" + "\n" * trailing
        return body + "\n"

    def flow(self, text):
        if text[0] == "{":
            if re.fullmatch(r"\{[ \t]*\}[ \t]*(?:#.*)?", text):
                self.i += 1
                return {}
            raise self.error("flow mappings are not supported")
        items = []
        j = 1
        expecting_item = True
        while True:
            while j < len(text) and text[j] in " \t":
                j += 1
            if j >= len(text):
                raise self.error("unterminated flow sequence (it must close on its line)")
            char = text[j]
            if char == "]":
                trailing = text[j + 1 :]
                if trailing.strip() and not re.match(r"[ \t]+#", trailing):
                    raise self.error("unexpected text after a flow sequence")
                self.i += 1
                return items
            if not expecting_item:
                if char != ",":
                    raise self.error("expected , or ] in a flow sequence")
                j += 1
                expecting_item = True
                continue
            if char in "[{":
                raise self.error("nested flow collections are not supported")
            if char in "'\"":
                value, end, state = self.scan_quoted(text, char, j + 1)
                if state != "closed":
                    raise self.error("unterminated quoted scalar in a flow sequence")
                items.append(value)
                j = end
            else:
                match = _FLOW_PLAIN.match(text, j)
                raw = match.group(0)
                if re.search(r"[ \t]#", raw) or raw.lstrip().startswith("#"):
                    raise self.error("a comment inside a flow sequence")
                if raw.strip() and raw.strip()[0] in _RESERVED_START:
                    raise self.error("anchors, aliases and tags are not supported")
                if not raw.strip():
                    raise self.error("an empty entry in a flow sequence")
                items.append(_plain_value(raw))
                j = match.end()
            expecting_item = False


def _fold_lines(lines):
    """Folded block scalar content: line breaks between plain lines become spaces."""
    out = []
    breaks = 0
    previous_more = False
    first = True
    for line in lines:
        if not line:
            breaks += 1
            continue
        more = line[0] in " \t"
        if first:
            out.append("\n" * breaks)
            first = False
        elif more or previous_more:
            out.append("\n" * (breaks + 1))
        else:
            out.append("\n" * breaks if breaks else " ")
        out.append(line)
        breaks = 0
        previous_more = more
    return "".join(out)
