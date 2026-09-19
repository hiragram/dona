import {matchWebRoute,WebRouteError} from './routes.js';
export type ParsedCallback={kind:'code';state:string;code:string}|{kind:'denied';state:string};
/** Parse only. The BFF must durably consume the matching cookie-bound login
 * before exchange. Provider descriptions/URLs never escape this parser. */
export function parseOidcCallback(target:unknown,issuer:string):ParsedCallback {
 try {
  if(typeof target!=='string' || matchWebRoute('GET',target).id!=='login_callback')throw new WebRouteError();
  const at=target.indexOf('?');if(at<0)throw new WebRouteError();
  const parts=target.slice(at+1).split('&');if(parts.length>8)throw new WebRouteError();
  const values=new Map<string,string>();
  const decode=(value:string)=>decodeURIComponent(value.replace(/\+/g,' '));
  for(const part of parts){
   const equal=part.indexOf('=');if(equal<1)throw new WebRouteError();
   const name=decode(part.slice(0,equal));const value=decode(part.slice(equal+1));
   if(!['code','state','iss','error','error_description','error_uri','session_state'].includes(name)
     || values.has(name) || /[\x00-\x1f\x7f]/.test(value))throw new WebRouteError();
   values.set(name,value);
  }
  const state=values.get('state');
  if(!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || Buffer.from(state,'base64url').toString('base64url')!==state)throw new WebRouteError();
  if(values.has('iss') && values.get('iss')!==issuer)throw new WebRouteError();
  const code=values.get('code'),error=values.get('error');
  if(code!==undefined && error!==undefined)throw new WebRouteError();
  if(error!==undefined){if(!error || error.length>128)throw new WebRouteError();return {kind:'denied',state};}
  if(!code || code.length>4096 || values.has('error_description') || values.has('error_uri'))throw new WebRouteError();
  return {kind:'code',code,state};
 }catch{throw new WebRouteError();}
}
