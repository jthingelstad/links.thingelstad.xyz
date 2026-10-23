# Quotes

<!--
Quotes for the front page of Linking Things, about the hyperlink and what it
is for. The build shows one a day under the search box (the same all day, US
Central; src/lib/quotes.ts reads this file) and shows nothing while the file
has no entries.

One entry per quote, in this shape, with a blank line between entries:

> The words, as plain text. A long quote may run over several lines, each
> starting with a greater-than sign; a line with only the sign starts a new
> paragraph.

Who: The person who said it
Source: https://example.com/the-page-where-they-said-it

The words are plain text, shown as written, with no Markdown inside them.
Who and Source are both required, and Source is an http or https address.
An entry missing either, or any other text outside this comment except a
heading, fails the build. Everything inside this comment is ignored.
-->
