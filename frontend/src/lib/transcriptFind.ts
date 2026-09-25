export function findTranscriptMatches(text: string, query: string): number[] {
  const normalizedQuery = query.toLowerCase();
  if (!query.trim()) return [];

  const normalizedText = text.toLowerCase();
  const matches: number[] = [];
  let searchFrom = 0;

  while (searchFrom <= normalizedText.length - normalizedQuery.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (matchIndex === -1) break;

    matches.push(matchIndex);
    searchFrom = matchIndex + normalizedQuery.length;
  }

  return matches;
}
