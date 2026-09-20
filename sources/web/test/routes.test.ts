import assert from 'node:assert/strict';
import test from 'node:test';
import {matchWebRoute,WebRouteError} from '../src/routes.js';
test('非正規pathとqueryによるidentity差替えを正規化前に拒否する',()=>{
 for(const target of ['//api/jobs','https://example.test/api/jobs','/api/./jobs','/api/jobs/../session','/api/jobs/%72','/api/jobs/r%2Fcancel','/api/jobs/r?principal_id=other','/api/jobs/r#secret','/api/jobs/r\\cancel','/api/jobs/r\0','/api/jobs/r/'])
  assert.throws(()=>matchWebRoute('GET',target),WebRouteError);
});
test('methodは認証済みcontextのroute identityに含み未定義verbを拒否する',()=>{
 assert.equal(matchWebRoute('GET','/api/jobs').id,'job_list');assert.equal(matchWebRoute('POST','/api/jobs').id,'job_submit');
 for(const method of ['HEAD','PUT','DELETE','OPTIONS','get'])assert.throws(()=>matchWebRoute(method,'/api/jobs'),WebRouteError);
 assert.throws(()=>matchWebRoute('GET','/api/jobs/r/cancel'),WebRouteError);
});
test('IdP障害時のlocal session例外を他resourceへ広げない',()=>{
 for(const target of ['/api/session/csrf','/api/session/logout','/api/session/logout-status'])assert.equal(matchWebRoute('POST',target).gate,'local_session');
 assert.equal(matchWebRoute('GET','/api/session').gate,'session');assert.equal(matchWebRoute('GET','/api/jobs/r').gate,'session');
 assert.throws(()=>matchWebRoute('GET','/api/session/csrf'),WebRouteError);
});
test('自動pollとSSEはuser activityにせずapproval decisionは独立step-upを要求する',()=>{
 assert.equal(matchWebRoute('GET','/api/jobs/r').activity,'automatic_poll');assert.equal(matchWebRoute('GET','/api/jobs/r/events').activity,'sse');
 const route=matchWebRoute('POST','/api/approvals/a/decision');assert.equal(route.gate,'approval_step_up');assert.equal(route.capability,'approval');assert.deepEqual(route.resource,{kind:'approval',id:'a'});
 assert.equal(matchWebRoute('GET','/').activity,'user_navigation');
});
test('OIDC callback以外へqueryを許可せずlogin完了案内はpublicのままにする',()=>{
 assert.equal(matchWebRoute('GET','/oidc/callback?code=fixture&state=fixture').gate,'login_callback');
 assert.equal(matchWebRoute('GET','/login/complete').gate,'public');assert.equal(matchWebRoute('GET','/login/complete').activity,'none');
 for(const target of ['/login?next=external','/login/complete?code=fixture','/?session=fixture'])assert.throws(()=>matchWebRoute('GET',target),WebRouteError);
});

test('login開始とCSRF準備は固定POSTだけを許可しresource権限を持たない',()=>{
 for(const target of ['/api/login/csrf','/api/login/start']) {
  const route=matchWebRoute('POST',target);assert.equal(route.gate,'public');assert.equal(route.capability,'authentication');assert.equal(route.activity,'none');assert.equal(route.resource,null);
  assert.throws(()=>matchWebRoute('GET',target),WebRouteError);assert.throws(()=>matchWebRoute('POST',target+'?next=other'),WebRouteError);
 }
});
