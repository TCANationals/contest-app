// Cloudflare Access JWT verification (§8.1).
//
// TODO: implement against `jose` with JWKS cached for 1 hour. Verify `aud`,
// `iss`, `exp`; extract `sub`, `email`, `groups`.

export interface JudgeIdentity {
  sub: string;
  email: string;
  groups: string[];
}

export async function verifyCfAccessJwt(_jwt: string): Promise<JudgeIdentity> {
  throw new Error('verifyCfAccessJwt: not implemented');
}

export function judgeRoomAccess(groups: string[]): 'all' | string[] {
  if (groups.includes('judges-admin')) return 'all';
  return groups
    .filter((g) => g.startsWith('judges-'))
    .map((g) => g.slice('judges-'.length));
}
