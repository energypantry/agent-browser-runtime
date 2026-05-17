// Example extractor contract. Stable site scripts can declare params schema + extract().
export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    includeLength: { type: 'boolean', default: false },
  },
};

export async function extract({ pageHtml, url, params, ui }) {
  // Site workflow scripts can use ui.type/click/press/scroll/waitFor before reading fresh HTML.
  void ui;
  const result = {
    url,
    title: pageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || null,
  };
  if (params.includeLength) result.htmlLength = pageHtml.length;
  return result;
}
