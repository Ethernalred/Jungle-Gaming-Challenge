import { CanActivate, Inject, Injectable } from '@nestjs/common';

/** D22 extension point: who is calling. Not implemented; ARCHITECTURE.md sketches Keycloak/OIDC. */
export abstract class ProviderIdentityPort {
  abstract identify(request: unknown): Promise<{ providerId: string } | null>;
}

export class NoopProviderIdentity extends ProviderIdentityPort {
  async identify() { return null; }
}

/** No-op: lets every request through. Health endpoints and the queue never use it. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort) {}
  async canActivate(ctx: import('@nestjs/common').ExecutionContext) {
    await this.identity.identify(ctx.switchToHttp().getRequest());
    return true; // ponytail: real checks (token, provider == body.providerId) land here
  }
}
