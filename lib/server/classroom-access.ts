import { isAuthEnabled } from '@/lib/auth/config';

/** Historic ownerless files remain intact, but cannot be claimed by guessing an ID. */
export function canReadLegacyClassroom(
  classroom: { ownerId?: string; published?: boolean },
  userId?: string,
): boolean {
  return (
    !isAuthEnabled() ||
    classroom.published === true ||
    Boolean(userId && classroom.ownerId === userId)
  );
}
