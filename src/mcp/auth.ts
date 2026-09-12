import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TokenProfile } from "../config.ts";

export class ProfileStore {
  private readonly profiles: TokenProfile[];
  constructor(profiles: TokenProfile[]) { this.profiles = profiles; }

  authenticate(req: IncomingMessage): TokenProfile | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return this.authenticateToken(header.slice(7));
  }

  authenticateToken(token: string): TokenProfile | undefined {
    const digest = createHash("sha256").update(token).digest();
    for (const profile of this.profiles) {
      const expected = Buffer.from(profile.tokenSha256, "hex");
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) return profile;
    }
    return undefined;
  }

  first(): TokenProfile | undefined { return this.profiles[0]; }

  get(clientProfileId: string): TokenProfile | undefined {
    return this.profiles.find((profile) => profile.clientProfileId === clientProfileId);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  allow(profile: TokenProfile): boolean {
    if (!Number.isSafeInteger(profile.rateLimit?.burst) || profile.rateLimit.burst < 1 ||
        !Number.isSafeInteger(profile.rateLimit?.requestsPerMinute) || profile.rateLimit.requestsPerMinute < 1) return false;
    const now = Date.now();
    const max = Math.max(1, profile.rateLimit.burst);
    const perMs = Math.max(1, profile.rateLimit.requestsPerMinute) / 60_000;
    const bucket = this.buckets.get(profile.clientProfileId) ?? { tokens: max, last: now };
    bucket.tokens = Math.min(max, bucket.tokens + (now - bucket.last) * perMs);
    bucket.last = now;
    if (bucket.tokens < 1) {
      this.buckets.set(profile.clientProfileId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(profile.clientProfileId, bucket);
    return true;
  }
}
