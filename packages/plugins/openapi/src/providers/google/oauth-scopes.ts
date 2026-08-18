const googleUserConsentBlockedScopes = new Set([
  "https://www.googleapis.com/auth/chat.bot",
  "https://www.googleapis.com/auth/chat.import",
  // Gmail sharing-setting writes require a service account with domain-wide
  // delegation, not the authorization-code flow used by user connections.
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/keep",
  "https://www.googleapis.com/auth/keep.readonly",
]);

const googleUserConsentBlockedScopePrefixes = [
  "https://www.googleapis.com/auth/chat.app.",
  // Contextual Gmail add-on scopes are minted for add-on executions, not a
  // standalone web OAuth connection.
  "https://www.googleapis.com/auth/gmail.addons.",
];

const googleMailScopesCoveredByFullAccess = new Set([
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
]);

const googleBroadScopeGroups: readonly {
  readonly broad: string;
  readonly covers: (scope: string) => boolean;
}[] = [
  {
    broad: "https://mail.google.com/",
    // Full mailbox access covers message, draft, label, and send operations,
    // but Google requires gmail.settings.basic separately for filter writes.
    covers: (scope) => googleMailScopesCoveredByFullAccess.has(scope),
  },
  {
    broad: "https://www.googleapis.com/auth/calendar",
    covers: (scope) => scope.startsWith("https://www.googleapis.com/auth/calendar."),
  },
  {
    broad: "https://www.googleapis.com/auth/drive",
    covers: (scope) => scope.startsWith("https://www.googleapis.com/auth/drive."),
  },
];

const normalizeGoogleIdentityScope = (scope: string): string =>
  scope === "https://www.googleapis.com/auth/userinfo.email"
    ? "email"
    : scope === "https://www.googleapis.com/auth/userinfo.profile"
      ? "profile"
      : scope;

const orderedUniqueScopes = (scopes: Iterable<string>): string[] => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
};

export const isGoogleUserConsentOAuthScope = (scope: string): boolean =>
  !googleUserConsentBlockedScopes.has(scope) &&
  !googleUserConsentBlockedScopePrefixes.some((prefix) => scope.startsWith(prefix));

export const filterGoogleUserConsentOAuthScopes = (scopes: Iterable<string>): string[] =>
  orderedUniqueScopes(scopes).filter(isGoogleUserConsentOAuthScope);

export const compactGoogleOAuthScopes = (scopes: Iterable<string>): string[] => {
  const ordered = filterGoogleUserConsentOAuthScopes([...scopes].map(normalizeGoogleIdentityScope));
  const present = new Set(ordered);
  return ordered.filter(
    (scope) =>
      !googleBroadScopeGroups.some(
        (group) => scope !== group.broad && present.has(group.broad) && group.covers(scope),
      ),
  );
};
