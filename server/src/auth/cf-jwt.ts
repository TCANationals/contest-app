export interface CfAccessClaims {
  sub: string;
  email: string;
  groups: string[];
}

export async function verifyCfAccessJwt(_rawJwt: string): Promise<CfAccessClaims> {
  // TODO(spec §8.1): implement CF Access JWT verification with jose + JWKS cache.
  throw new Error("Not implemented: verifyCfAccessJwt");
}
