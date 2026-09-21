import { WebInternalService, type WebJobReadGrantOperatorKey } from "./internal-service.js";
import type { WebAuthRepository } from "./repository.js";
import type { ServiceScope, WebServiceCredentialLookup } from "./service-auth.js";
import type { WebJobReadBroker } from "./job-read-broker.js";
import type { WebCommandBroker } from "./command-broker.js";

/** Fixed all protocol exposure. Runtime must establish protected providers
 * and readiness before start(); importing this module starts no listener. */
export class WebInternalGateway extends WebInternalService {
  constructor(socketPath: string, scope: ServiceScope, repository: WebAuthRepository,
    credentials: WebServiceCredentialLookup, now: () => string, deadlineMs = 5000,
    commands?: WebCommandBroker, jobReads?: WebJobReadBroker, grantOperatorKey?:WebJobReadGrantOperatorKey) {
    super(socketPath, scope, repository, credentials, now, deadlineMs, "all", commands, jobReads,grantOperatorKey);
  }
}
