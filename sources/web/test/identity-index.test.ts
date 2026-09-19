import assert from "node:assert/strict";
import test from "node:test";
import { subjectLookupIndexes, newSubjectIndex, matchSubjectPrincipal, type IdentityIndexInventory, IdentityIndexError } from "../src/identity-index.js";
const subject = { instance_id:"instance1",tenant_id:"tenant1",issuer:"https://id.example.test",subject:"User1" };
const inventory = (): IdentityIndexInventory => ({ retained_versions:[1,2],active_version:2,keys:[
  { version:1,purpose:"web_identity_index",state:"lookup_only",secret:Buffer.alloc(32,1) },
  { version:2,purpose:"web_identity_index",state:"active",secret:Buffer.alloc(32,2) },
] });
test("全versionをlookupし新しいindexだけを現行keyで作る", () => {
  const all=subjectLookupIndexes(subject,inventory()); assert.deepEqual(all.map(x=>x.identity_index_key_version),[1,2]);
  assert.notEqual(all[0]!.subject_digest,all[1]!.subject_digest); assert.deepEqual(newSubjectIndex(subject,inventory()),all[1]);
});
test("subjectのcase・Unicode表現・issuer・tenantを正規化して混同しない", () => {
  const changed=[subject,{...subject,subject:"user1"},{...subject,issuer:subject.issuer+"/"},{...subject,tenant_id:"tenant2"},
    {...subject,subject:"é"},{...subject,subject:"e\u0301"}];
  assert.equal(new Set(changed.map(x=>newSubjectIndex(x,inventory()).subject_digest)).size,changed.length);
});
test("旧key欠落・revoked・用途違い・不完全inventoryでは新規作成も止める", () => {
  const cases:IdentityIndexInventory[]=[];
  let item=inventory(); item.keys=item.keys.slice(1); cases.push(item);
  item=inventory(); item.keys[0]!.state="revoked"; cases.push(item);
  item=inventory(); item.retained_versions=[1,1]; cases.push(item);
  item=inventory(); item.active_version=3; cases.push(item);
  item=inventory(); item.keys[0]!.purpose="audit" as never; cases.push(item);
  item=inventory(); item.keys[0]!.secret=Buffer.alloc(0); cases.push(item);
  for(const value of cases) { assert.throws(()=>subjectLookupIndexes(subject,value),IdentityIndexError); assert.throws(()=>newSubjectIndex(subject,value),IdentityIndexError); }
});
test("rotation後も同一principalへ収束し複数principalと重複rowを拒否する", () => {
  const candidates=subjectLookupIndexes(subject,inventory()); const rows=candidates.map(x=>({...x,principal_id:"principal1"}));
  assert.equal(matchSubjectPrincipal(candidates,rows),"principal1"); assert.equal(matchSubjectPrincipal(candidates,rows.slice(0,1)),"principal1");
  assert.equal(matchSubjectPrincipal(candidates,[]),null);
  assert.throws(()=>matchSubjectPrincipal(candidates,[{principal_id:"principal1"} as never]),IdentityIndexError);
  assert.throws(()=>matchSubjectPrincipal(candidates,[rows[0]!,{...rows[1]!,principal_id:"principal2"}]),IdentityIndexError);
  assert.throws(()=>matchSubjectPrincipal(candidates,[rows[0]!,rows[0]!]),IdentityIndexError);
  assert.throws(()=>matchSubjectPrincipal(candidates,[{...rows[0]!,subject_digest:"0".repeat(64)}]),IdentityIndexError);
});
