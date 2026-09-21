import { zaokitResponse, zaokitResponseText } from '@/lib/zaokit/api';
import type { WebSearchResult, WebSearchSource } from '@/lib/types/web-search';

export async function searchWithZaokit(params: {
  query: string;
  apiKey: string;
  baseUrl?: string;
  maxResults?: number;
  signal?: AbortSignal;
}): Promise<WebSearchResult> {
  const started = Date.now();
  const data = await zaokitResponse(
    params,
    {
      input: params.query,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
    },
    params.signal,
  );
  // Only use returned citations; never invent URLs from model prose.
  const sources = new Map<string, WebSearchSource>();
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      for (const citation of part.annotations || []) {
        if (citation.type !== 'url_citation' || !citation.url) continue;
        try {
          const url = new URL(citation.url);
          if (!['http:', 'https:'].includes(url.protocol)) continue;
          sources.set(url.href, {
            url: url.href,
            title: citation.title || url.hostname,
            content: '',
            score: 1,
          });
        } catch {
          /* Ignore malformed citations. */
        }
      }
    }
  }
  if (!sources.size) throw new Error('Zaokit search returned no verifiable sources');
  return {
    query: params.query,
    answer: zaokitResponseText(data),
    sources: [...sources.values()].slice(0, params.maxResults || 10),
    responseTime: (Date.now() - started) / 1000,
  };
}
