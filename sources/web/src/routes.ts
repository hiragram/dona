/** Fixed ingress identities used for context binding. Matching a route never
 * authorizes a resource; the caller must enforce every indicated current gate. */
export interface WebRoute {
  id: string;
  method: "GET" | "POST";
  gate: "public" | "login_callback" | "local_session" | "session" | "approval_step_up";
  capability: "authentication" | "job_read" | "job_command" | "approval";
  activity: "none" | "user_navigation" | "user_command" | "automatic_poll" | "sse";
  resource: null | { kind: "job" | "approval"; id: string };
}
export interface WebRouteAuthorizationGates {
  csrf_verified?: boolean;
  step_up_verified?: boolean;
}
export type WebRouteAuthorization = { allowed: true } | { allowed: false; reason: "operation_unsupported" | "scope_denied" | "csrf_invalid" | "step_up_required" };
interface ScopePrincipal { role_ids: readonly string[]; scopes: readonly string[] }
interface Definition extends Omit<WebRoute,"resource"> { pattern: RegExp; resourceKind?: "job" | "approval" }
const definitions: readonly Definition[] = [
  {id:"login",method:"GET",pattern:/^\/login$/,gate:"public",capability:"authentication",activity:"none"},
  {id:"prelogin_csrf",method:"POST",pattern:/^\/api\/login\/csrf$/,gate:"public",capability:"authentication",activity:"none"},
  {id:"login_start",method:"POST",pattern:/^\/api\/login\/start$/,gate:"public",capability:"authentication",activity:"none"},
  {id:"login_callback",method:"GET",pattern:/^\/oidc\/callback$/,gate:"login_callback",capability:"authentication",activity:"none"},
  {id:"login_complete",method:"GET",pattern:/^\/login\/complete$/,gate:"public",capability:"authentication",activity:"none"},
  {id:"dashboard",method:"GET",pattern:/^\/$/,gate:"session",capability:"authentication",activity:"user_navigation"},
  {id:"session",method:"GET",pattern:/^\/api\/session$/,gate:"session",capability:"authentication",activity:"automatic_poll"},
  {id:"local_csrf",method:"POST",pattern:/^\/api\/session\/csrf$/,gate:"local_session",capability:"authentication",activity:"none"},
  {id:"logout",method:"POST",pattern:/^\/api\/session\/logout$/,gate:"local_session",capability:"authentication",activity:"none"},
  {id:"logout_status",method:"POST",pattern:/^\/api\/session\/logout-status$/,gate:"local_session",capability:"authentication",activity:"none"},
  {id:"job_list",method:"GET",pattern:/^\/api\/jobs$/,gate:"session",capability:"job_read",activity:"automatic_poll"},
  {id:"job_submit",method:"POST",pattern:/^\/api\/jobs$/,gate:"session",capability:"job_command",activity:"user_command"},
  {id:"job_read",method:"GET",pattern:/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/,resourceKind:"job",gate:"session",capability:"job_read",activity:"automatic_poll"},
  {id:"job_events",method:"GET",pattern:/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/events$/,resourceKind:"job",gate:"session",capability:"job_read",activity:"sse"},
  {id:"job_cancel",method:"POST",pattern:/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/cancel$/,resourceKind:"job",gate:"session",capability:"job_command",activity:"user_command"},
  {id:"approval_read",method:"GET",pattern:/^\/api\/approvals\/([A-Za-z0-9_-]{1,128})$/,resourceKind:"approval",gate:"session",capability:"approval",activity:"automatic_poll"},
  {id:"approval_challenge",method:"POST",pattern:/^\/api\/approvals\/([A-Za-z0-9_-]{1,128})\/challenge$/,resourceKind:"approval",gate:"session",capability:"approval",activity:"user_command"},
  {id:"approval_decision",method:"POST",pattern:/^\/api\/approvals\/([A-Za-z0-9_-]{1,128})\/decision$/,resourceKind:"approval",gate:"approval_step_up",capability:"approval",activity:"user_command"},
];
export class WebRouteError extends Error {constructor(){super("web_route_invalid");this.name="WebRouteError";}}
const scopeRequirements: Readonly<Record<string, readonly string[]>> = {
  job_list: ["job:read:own", "job:read:granted"], job_submit: ["job:submit"],
  job_read: ["job:read:own", "job:read:granted"], job_events: ["job:read:own", "job:read:granted"],
  job_cancel: ["job:cancel:own"], approval_read: ["approval:read:bound"],
  approval_challenge: ["approval:decide:bound"], approval_decision: ["approval:decide:bound"],
};
const roleScopes: Readonly<Record<string, readonly string[]>> = {
  requester: ["job:submit", "job:read:own", "job:cancel:own"], observer: ["job:read:granted"],
  supervisor: ["approval:read:bound", "approval:decide:bound"],
};
/** Route-level eligibility only. The authoritative command/read/approval
 * repository must still enforce owner, grant, binding, receipt and resource
 * predicates in the same transaction as its operation. */
export function authorizeWebRoute(principal: ScopePrincipal, route: WebRoute, gates: WebRouteAuthorizationGates = {}): WebRouteAuthorization {
  if (!["session", "approval_step_up"].includes(route.gate)) return { allowed: false, reason: "operation_unsupported" };
  if (route.method === "POST" && gates.csrf_verified !== true) return { allowed: false, reason: "csrf_invalid" };
  if (route.gate === "approval_step_up" && gates.step_up_verified !== true) return { allowed: false, reason: "step_up_required" };
  if (route.capability === "authentication") return { allowed: true };
  const roles = new Set(principal.role_ids), scopes = new Set(principal.scopes);
  if (roles.size !== principal.role_ids.length || scopes.size !== principal.scopes.length
    || [...roles].some(role => !(role in roleScopes))
    || [...scopes].some(scope => ![...roles].some(role => roleScopes[role]!.includes(scope)))) return { allowed: false, reason: "scope_denied" };
  const required = scopeRequirements[route.id];
  if (!required || !required.some(scope => scopes.has(scope))) return { allowed: false, reason: "scope_denied" };
  return { allowed: true };
}
/** Validates the shape of a signed route binding; this does not authorize it. */
export function matchesRouteBinding(routeId:string,method:string,resource:WebRoute["resource"]):boolean {
  const definition=definitions.find(value=>value.id===routeId && value.method===method);
  return definition!==undefined && (definition.resourceKind===undefined ? resource===null
    : resource!==null && resource.kind===definition.resourceKind && /^[A-Za-z0-9_-]{1,128}$/.test(resource.id));
}
/** Pass the raw request target BEFORE URL normalization. Only the OIDC callback
 * permits a query, which its dedicated parser must validate without logging. */
export function matchWebRoute(method:unknown,target:unknown):WebRoute {
  if(typeof method!=="string" || typeof target!=="string" || target.length>8192
    || !target.startsWith("/") || target.startsWith("//") || /[\x00-\x20\x7f#\\]/.test(target))throw new WebRouteError();
  const queryAt=target.indexOf("?");const pathname=queryAt<0?target:target.slice(0,queryAt);
  if(pathname.includes("%"))throw new WebRouteError();
  for(const definition of definitions){
    const match=definition.method===method?definition.pattern.exec(pathname):null;
    if(!match)continue;
    if(queryAt>=0 && !["login_callback","job_list"].includes(definition.id))throw new WebRouteError();
    return {id:definition.id,method:definition.method,gate:definition.gate,capability:definition.capability,
      activity:definition.activity,resource:definition.resourceKind?{kind:definition.resourceKind,id:match[1]!}:null};
  }
  throw new WebRouteError();
}
