import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { ensurePrivateToken, readPrivateToken } from "../src/private-token.js";

const roots:string[]=[];
afterEach(async()=>Promise.all(roots.splice(0).map((root)=>fs.rm(root,{recursive:true,force:true}))));

test("target Dispatcher自身がdevと旧updater経由の起動前にingress keyを原子的に用意する",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-private-token-"));roots.push(root);
  const tokenPath=path.join(root,"control","slack-ingress.token");
  const first=await ensurePrivateToken(tokenPath),second=await ensurePrivateToken(tokenPath);
  assert.match(first,/^[0-9a-f]{64}$/);assert.equal(second,first);
  assert.equal((await fs.stat(tokenPath)).mode&0o777,0o600);
  assert.equal(await readPrivateToken(tokenPath),first);
});

test("既存のlooseまたは壊れたkeyを上書きせずfail-closedにする",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-private-token-invalid-"));roots.push(root);
  const tokenPath=path.join(root,"slack-ingress.token");
  await fs.writeFile(tokenPath,"short\n",{mode:0o644});
  await assert.rejects(()=>ensurePrivateToken(tokenPath),/present but invalid/);
  assert.equal(await fs.readFile(tokenPath,"utf8"),"short\n");
});
