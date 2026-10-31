// A lens (docs/DIRECTION.md, "Lenses"; Jamie, 2026-10-31: "Approved: build
// Linking Things direction A in three phases (sky landing, lens pages at
// their own URLs with on-this-day and topic lenses, sky share cards after
// previews)"): what a page that is a lens on the sky (src/components/
// Lens.astro) tells the sky beside it. The sky lights the links the page
// lists (`set`: an issue, a year, a site, a kind), or stands on the page's
// own link with its ten nearest round it (`star`: a record).
export interface Lens {
  kind: 'set' | 'star';
  // The record's id, for a `star` lens.
  star?: string;
  // The gold chip on the sky: "Lens: WT354".
  label: string;
  // The layout the lens opens in, unless the address says otherwise.
  view?: 'time';
  // The part of the site the lens belongs to (its index page), for the ways
  // in on the sky's bar.
  section?: string;
  // The lenses beside it: the issue before and after, the year before and
  // after.
  chips?: { href: string; label: string; rel?: 'prev' | 'next' }[];
}
