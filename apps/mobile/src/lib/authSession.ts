export interface AuthPrincipalBoundary {
  generation: number;
  userId: string;
}

export interface AuthSessionSnapshot extends AuthPrincipalBoundary {
  accessToken: string;
  refreshToken: string;
  /** Opaque, non-credential identifier for persisted client work. It rotates
   * at every interactive login/logout boundary and survives token refresh. */
  adEventScopeId?: string;
}

export interface RotatedAuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthRefreshOutcome {
  accessToken: string;
  session: AuthSessionSnapshot;
}

export interface AuthSessionSource {
  current: () => AuthSessionSnapshot | null;
  rotateTokensIfCurrent: (
    expected: AuthSessionSnapshot,
    tokens: RotatedAuthTokens,
  ) => AuthSessionSnapshot | null;
  logoutIfCurrent: (expected: AuthSessionSnapshot) => boolean;
}

export function samePrincipalBoundary(
  left: AuthPrincipalBoundary | null,
  right: AuthPrincipalBoundary | null,
): boolean {
  return !!left && !!right && left.generation === right.generation && left.userId === right.userId;
}

export function sameAuthSession(
  left: AuthSessionSnapshot | null,
  right: AuthSessionSnapshot | null,
): boolean {
  return samePrincipalBoundary(left, right) && left!.refreshToken === right!.refreshToken;
}

/** Return credentials only when they belong to the runtime owner that asked
 * for them. This is the safe bridge from a generation/user lease to a freshly
 * rotated access token; a stale A callback receives null after B logs in. */
export function authSessionForPrincipal(
  current: AuthSessionSnapshot | null,
  owner: AuthPrincipalBoundary,
): AuthSessionSnapshot | null {
  return samePrincipalBoundary(current, owner) ? current : null;
}

interface RefreshFlight {
  session: AuthSessionSnapshot;
  promise: Promise<AuthRefreshOutcome | null>;
}

/**
 * Coordinates refresh-token rotation without ever crossing a login boundary.
 * A user can log out, or another user can log in, while the network request is
 * pending; every write is therefore conditional on the exact captured session.
 */
export class AuthRefreshCoordinator {
  private inFlight: RefreshFlight | null = null;

  constructor(
    private readonly source: AuthSessionSource,
    private readonly refresh: (refreshToken: string) => Promise<RotatedAuthTokens>,
    private readonly shouldLogoutAfterRefreshFailure: (error: unknown) => boolean = () => false,
  ) {}

  resolve(session: AuthSessionSnapshot): Promise<AuthRefreshOutcome | null> {
    const current = this.source.current();
    if (!samePrincipalBoundary(current, session)) return Promise.resolve(null);

    // Another 401 may arrive after a sibling request already rotated the pair.
    // Reuse the new access token instead of replaying the consumed refresh token.
    if (!sameAuthSession(current, session)) {
      return Promise.resolve({ accessToken: current!.accessToken, session: current! });
    }

    if (this.inFlight && sameAuthSession(this.inFlight.session, session)) {
      return this.inFlight.promise;
    }

    const flight = {} as RefreshFlight;
    flight.session = session;
    flight.promise = this.refresh(session.refreshToken)
      .then((tokens) => {
        const rotated = this.source.rotateTokensIfCurrent(session, tokens);
        return rotated ? { accessToken: rotated.accessToken, session: rotated } : null;
      })
      .catch((error: unknown) => {
        // Offline, timeout and server failures are availability problems, not
        // evidence that the credential was revoked. Only an authoritative auth
        // rejection may end the exact session that attempted this refresh.
        if (this.shouldLogoutAfterRefreshFailure(error)) {
          // A stale failure from account A must never log out account B.
          this.source.logoutIfCurrent(session);
        }
        return null;
      })
      .finally(() => {
        // A newer account may already own a different flight.
        if (this.inFlight === flight) this.inFlight = null;
      });

    this.inFlight = flight;
    return flight.promise;
  }
}
