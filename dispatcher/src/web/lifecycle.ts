import {encodeWebAuthState,WebStateError,type WebAuthState} from "./model.js";
function checked(input:WebAuthState,now:string):WebAuthState {
 const state=encodeWebAuthState(input).state,at=Date.parse(now);
 if(!Number.isFinite(at) || new Date(at).toISOString()!==now || at<Date.parse(state.updated_at))throw new WebStateError();
 return state;
}
function increment(value:number):number {if(!Number.isSafeInteger(value) || value>=Number.MAX_SAFE_INTEGER)throw new WebStateError();return value+1;}
/** Pure plans only: the repository must persist metadata and delete the removed
 * secret references together under the shared protected-clock/audit transaction. */
export function restartWebAuthState(input:WebAuthState,now:string):WebAuthState {
 const state=checked(input,now);
 return encodeWebAuthState({...state,bff_generation:increment(state.bff_generation),updated_at:now,
  sessions:state.sessions.map(session=>({...session,state:{...session.state,state:"revoked"},payload_ref:null,payload_digest:null})),
  logins:[],consumed_logins:[],used_nonces:[]}).state;
}
export function revokeWebPrincipal(input:WebAuthState,principalId:string,now:string):WebAuthState {
 const state=checked(input,now),principal=state.principals.find(row=>row.principal_id===principalId);
 if(!principal)throw new WebStateError();
 const refs=new Set(state.sessions.filter(row=>row.state.principal_id===principalId).map(row=>row.state.session_ref));
 return encodeWebAuthState({...state,updated_at:now,
  principals:state.principals.map(row=>row.principal_id!==principalId || row.state==="revoked"?row:
   {...row,state:"revoked",revoke_generation:increment(row.revoke_generation)}),
  sessions:state.sessions.map(row=>row.state.principal_id!==principalId?row:
   {...row,state:{...row.state,state:"revoked"},payload_ref:null,payload_digest:null}),
  used_nonces:state.used_nonces.filter(row=>!refs.has(row.session_ref))}).state;
}
export function pruneExpiredWebState(input:WebAuthState,now:string):WebAuthState {
 const state=checked(input,now),at=Date.parse(now);
 const sessions=state.sessions.filter(row=>{
  const session=row.state;
  // Keep revoked references until their original bounded validity window ends.
  // Registry principals and retained subject aliases are never pruned here.
  return at<Date.parse(session.expires_at) && at<Date.parse(session.access_token_expires_at)
   && at-Date.parse(session.last_activity_at)<30*60*1000;
 });
 const refs=new Set(sessions.map(row=>row.state.session_ref));
 return encodeWebAuthState({...state,updated_at:now,sessions,
  logins:state.logins.filter(row=>at<Date.parse(row.binding.expires_at)),
  consumed_logins:state.consumed_logins.filter(row=>at<Date.parse(row.expires_at)),
  used_nonces:state.used_nonces.filter(row=>refs.has(row.session_ref) && at<Date.parse(row.expires_at))}).state;
}
