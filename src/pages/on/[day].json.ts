// On this day's JSON twin (/on/MM-DD.json): every link saved on one Central
// calendar day, in any year, newest first, as /on/MM-DD/ lists them. Small on
// purpose, a few dozen links at most, so a page elsewhere can read one day
// without the whole of /links.json; each link's full record is its own twin.
// A note keeps its voice beside it: only "jamie" is Jamie's own words.
import type { APIRoute, GetStaticPaths } from 'astro';
import {
  absolute,
  appearances,
  calendarDays,
  dayKey,
  issuePath,
  linkJsonPath,
  linkPath,
  linksByDayOfYear,
  monthNames,
  onPath,
} from '../../lib/data';

export const getStaticPaths: GetStaticPaths = () =>
  calendarDays.map(({ month, day }) => ({
    params: { day: dayKey(month, day) },
    props: { month, day },
  }));

export const GET: APIRoute = ({ props }) => {
  const { month, day } = props as { month: number; day: number };
  const list = [...(linksByDayOfYear.get(dayKey(month, day)) ?? [])].reverse();
  const body = {
    day: dayKey(month, day),
    label: `${monthNames[month - 1]} ${day}`,
    page: absolute(onPath(month, day)),
    count: list.length,
    links: list.map((link) => ({
      id: link.id,
      title: link.title,
      url: link.url,
      note: link.note,
      voice: link.voice,
      saved: link.saved,
      day: link.day,
      record: absolute(linkPath(link.id)),
      json: absolute(linkJsonPath(link.id)),
      issues: (appearances.get(link.id) ?? []).map((a) => ({
        number: a.issue.number,
        title: a.issue.title,
        page: absolute(issuePath(a.issue)),
      })),
    })),
  };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
