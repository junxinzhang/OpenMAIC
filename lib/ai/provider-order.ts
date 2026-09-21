/** Keep Zaokit first even when saved settings predate its introduction. */
export function prioritizeZaokit<T extends { id: string }>(providers: readonly T[]): T[] {
  const isZaokit = (provider: T) => /^zaokit(?:-|$)/.test(provider.id);
  return [...providers.filter(isZaokit), ...providers.filter((provider) => !isZaokit(provider))];
}
