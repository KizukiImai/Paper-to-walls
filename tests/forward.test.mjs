import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { validateTarget, requestTarget } from '../server/forward.mjs';
const layout={schemaVersion:1,layoutId:'remote-test',units:'m',wallHeight:2.5,wallThickness:.15,walls:[{id:'w1',ax:0,ay:0,bx:4,by:0}]};
async function start(options={}) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'paper-lan-'));const server=await createApp({dataDir,...options});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {server,dataDir,port:server.address().port,base:`http://127.0.0.1:${server.address().port}`,
    close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dataDir,{recursive:true,force:true});}};
}
const post=(app,route,value,headers={})=>fetch(app.base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
test('IP/port are restricted to explicit LAN addresses (not URLs or public hosts)',()=>{
  for(const host of ['192.168.1.20','10.1.2.3','172.16.0.15','127.0.0.1']) assert.equal(validateTarget({host,port:3001}).host,host);
  for(const host of ['https://192.168.1.20','192.168.1.20:3001','8.8.8.8','169.254.169.254','example.com','127.1','::1','2130706433','0177.0.0.1']) assert.throws(()=>validateTarget({host,port:3001}));
  for(const port of [0,65536,1.5,'3001',null]) assert.throws(()=>validateTarget({host:'192.168.1.20',port}));
  assert.throws(()=>validateTarget({host:'127.0.0.1',port:3001,key:'x\r\ny'}));
});
test('real HTTP sender -> receiver, remote persistence and monotonically assigned revisions',async()=>{
  const sender=await start(),receiver=await start({allowForward:false});
  try {
    const target={host:'127.0.0.1',port:receiver.port};
    const check=await post(sender,'/api/targets/check',{target});assert.equal(check.status,200);assert.equal((await check.json()).ok,true);
    for(let revision=1;revision<=2;revision++) {
      const sent=await post(sender,'/api/targets/send',{target,layout});assert.equal(sent.status,200);const result=await sent.json();assert.equal(result.revision,revision);assert.equal(result.delivery,'stored-on-receiver');
    }
    const saved=await (await fetch(receiver.base+'/api/layouts/latest')).json();assert.deepEqual(saved.walls,layout.walls);assert.equal(saved.revision,2);
    assert.equal(JSON.parse(await readFile(path.join(receiver.dataDir,'latest-layout.json'),'utf8')).revision,2);
    assert.equal((await fetch(sender.base+'/api/layouts/latest')).status,204,'sender must not pretend local data was delivered');
    const clear=await post(sender,'/api/targets/send',{target,layout:{...layout,walls:[]}});assert.equal(clear.status,200);
    assert.deepEqual((await (await fetch(receiver.base+'/api/layouts/latest')).json()).walls,[]);
  } finally {await sender.close();await receiver.close();}
});
test('receiver key is checked and never written into the saved layout',async()=>{
  const sender=await start(),receiver=await start({receiveKey:'test-key',allowForward:false});
  try {
    const target={host:'127.0.0.1',port:receiver.port,key:'wrong'};
    const denied=await post(sender,'/api/targets/send',{target,layout});assert.equal(denied.status,502);
    assert.equal((await fetch(receiver.base+'/api/layouts/latest')).status,204);
    const sent=await post(sender,'/api/targets/send',{target:{...target,key:'test-key'},layout});assert.equal(sent.status,200);
    assert.equal((await readFile(path.join(receiver.dataDir,'latest-layout.json'),'utf8')).includes('test-key'),false);
  } finally {await sender.close();await receiver.close();}
});
test('invalid geometry, cross-origin and malformed relay requests never mutate receiver',async()=>{
  const sender=await start(),receiver=await start();
  try {
    const target={host:'127.0.0.1',port:receiver.port};
    assert.equal((await post(sender,'/api/targets/send',{target,layout:{...layout,wallHeight:-1}})).status,422);
    assert.equal((await post(sender,'/api/targets/send',{target,layout},{Origin:'https://untrusted.test'})).status,403);
    assert.equal((await post(sender,'/api/targets/send',null)).status,422);
    assert.equal((await post(sender,'/api/targets/check',{target},{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await fetch(receiver.base+'/api/layouts/latest')).status,204);
  } finally {await sender.close();await receiver.close();}
});
test('receiver-only mode does not expose forwarding',async()=>{
  const receiver=await start({allowForward:false});
  try {assert.equal((await post(receiver,'/api/targets/check',{target:{host:'127.0.0.1',port:receiver.port}})).status,403);}
  finally {await receiver.close();}
});
test('refused connection returns actionable error instead of false success',async()=>{
  const temp=http.createServer();await new Promise(r=>temp.listen(0,'127.0.0.1',r));const port=temp.address().port;await new Promise(r=>temp.close(r));
  const sender=await start();try {const response=await post(sender,'/api/targets/check',{target:{host:'127.0.0.1',port}});assert.equal(response.status,502);assert.match((await response.json()).error,/接続できません/);}finally {await sender.close();}
});
test('redirects are not followed, timeouts abort the request',async()=>{
  let redirected=0;
  const remote=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/success'});res.end('{}');}else if(req.url==='/success'){redirected++;res.end('{}');}});
  await new Promise(r=>remote.listen(0,'127.0.0.1',r));const target={host:'127.0.0.1',port:remote.address().port,key:''};
  try {
    await assert.rejects(requestTarget(target,'GET','/redirect',undefined,200),/リダイレクト/);
    assert.equal(redirected,0);
    await assert.rejects(requestTarget(target,'GET','/timeout',undefined,50),/応答しません/);
  }finally {remote.closeAllConnections();await new Promise(r=>remote.close(r));}
});
