type LoadOwner = symbol;

type ActivityLoadOwner = {
  conversationId: string;
  owner: LoadOwner;
};

const conversationLoadOwners = new Map<string, LoadOwner>();
const activityLoadOwners = new Map<string, ActivityLoadOwner>();

export function beginConversationLoad(conversationId: string): LoadOwner {
  const owner = Symbol();
  conversationLoadOwners.set(conversationId, owner);
  return owner;
}

export function ownsConversationLoad(
  conversationId: string,
  owner: LoadOwner,
): boolean {
  return conversationLoadOwners.get(conversationId) === owner;
}

export function releaseConversationLoad(
  conversationId: string,
  owner: LoadOwner,
): void {
  if (ownsConversationLoad(conversationId, owner)) {
    conversationLoadOwners.delete(conversationId);
  }
}

export function beginActivityLoad(
  conversationId: string,
  itemId: string,
): LoadOwner {
  const owner = Symbol();
  activityLoadOwners.set(itemId, { conversationId, owner });
  return owner;
}

export function ownsActivityLoad(itemId: string, owner: LoadOwner): boolean {
  return activityLoadOwners.get(itemId)?.owner === owner;
}

export function releaseActivityLoad(itemId: string, owner: LoadOwner): void {
  if (ownsActivityLoad(itemId, owner)) {
    activityLoadOwners.delete(itemId);
  }
}

export function invalidateConversationLoads(conversationId: string): void {
  conversationLoadOwners.delete(conversationId);
  for (const [itemId, load] of activityLoadOwners) {
    if (load.conversationId === conversationId) {
      activityLoadOwners.delete(itemId);
    }
  }
}

export function invalidateLoadsOutsideSnapshot(
  conversationIds: ReadonlySet<string>,
): void {
  for (const conversationId of conversationLoadOwners.keys()) {
    if (!conversationIds.has(conversationId)) {
      conversationLoadOwners.delete(conversationId);
    }
  }
  for (const [itemId, load] of activityLoadOwners) {
    if (!conversationIds.has(load.conversationId)) {
      activityLoadOwners.delete(itemId);
    }
  }
}

export function resetLoadOwnershipForTests(): void {
  conversationLoadOwners.clear();
  activityLoadOwners.clear();
}
