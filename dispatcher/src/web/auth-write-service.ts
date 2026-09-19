import { WebInternalService } from "./internal-service.js";
import type { WebAuthRepository } from "./repository.js";
import type { ServiceScope, WebServiceCredentialLookup } from "./service-auth.js";

/** Fixed write protocol exposure. Runtime must establish protected providers
 * and readiness before start(); importing this module starts no listener. */
export class WebAuthWriteService extends WebInternalService {
  constructor(socketPath: string, scope: ServiceScope, repository: WebAuthRepository,
    credentials: WebServiceCredentialLookup, now: () => string, deadlineMs = 5000) {
    super(socketPath, scope, repository, credentials, now, deadlineMs, "write");
  }
}
