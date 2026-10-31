import type { APIRoute, GetStaticPaths } from 'astro';
import { type SkyTopic, skyTopics, topicSlug } from '../../../lib/data';
import { jsonFeedText, topicFeed } from '../../../lib/feeds';
import { topicLinks } from '../../../lib/stars';

export const getStaticPaths: GetStaticPaths = () =>
  skyTopics
    .filter((topic) => topicLinks(topic.id).length)
    .map((topic) => ({
      params: { topic: topicSlug(topic.name) },
      props: { topic },
    }));

export const GET: APIRoute = ({ props }) =>
  new Response(jsonFeedText(topicFeed((props as { topic: SkyTopic }).topic)), {
    headers: { 'content-type': 'application/feed+json; charset=utf-8' },
  });
