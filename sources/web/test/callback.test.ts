import assert from 'node:assert/strict';
import test from 'node:test';
import {parseOidcCallback} from '../src/callback.js';
import {WebRouteError} from '../src/routes.js';
const state=Buffer.alloc(32,1).toString('base64url');
const issuer='https://issuer.example.test';
const target='/oidc/callback?state='+state;
test('callbackの重複fieldと曖昧なpercent encodingを消費前に拒否する',()=>{
 for(const query of ['&code=a&code=a','&code=a&st%61te='+state,'&code=%FF','&code=%','&code=%00','&code=a&error=denied','&code=a&principal_id=other'])
  assert.throws(()=>parseOidcCallback(target+query,issuer),WebRouteError);
 assert.deepEqual(parseOidcCallback(target+'&code=a%2Bb&iss='+encodeURIComponent(issuer),issuer),{kind:'code',state,code:'a+b'});
});
test('providerのerror説明とURLを表示用結果へ渡さず固定issuerの不一致を拒否する',()=>{
 assert.deepEqual(parseOidcCallback(target+'&error=access_denied&error_description=private-fixture&error_uri=https%3A%2F%2Fother.example.test',issuer),{kind:'denied',state});
 assert.throws(()=>parseOidcCallback(target+'&code=a&iss=https%3A%2F%2Fother.example.test',issuer),WebRouteError);
 assert.throws(()=>parseOidcCallback(target+'&code=a&error_description=private-fixture',issuer),WebRouteError);
});
test('callbackは一回消費の代替にならず必須stateとサイズを検証する',()=>{
 for(const value of ['/oidc/callback?code=a',target+'&code=',target+'&code='+ 'a'.repeat(4097),'/login/complete?state='+state+'&code=a'])
  assert.throws(()=>parseOidcCallback(value,issuer),WebRouteError);
 assert.deepEqual(parseOidcCallback(target+'&code=fixture',issuer),parseOidcCallback(target+'&code=fixture',issuer));
});
