import fs from 'node:fs'; import vm from 'node:vm'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root=new URL('../',import.meta.url).pathname;
const VRData = new Function(fs.readFileSync(root+'js/vr/data.js','utf8')+'; return VRData;')();
const SM = require(root+'js/api/scenemap.js');
SM.__data = VRData; SM.__text = { body:"x", font:"display", weight:700, fs:1, color:"#f5f1ea", align:"center", card:false, cardCol:"#1b1724", cardOp:.85, width:1 };
let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log('FAIL',m);} else console.log('ok  ',m); };
const model = { view:{dome:4.5}, bg: VRData.presetBg('glum'), items:[
 {id:'a1',type:'image',name:'Moon',az:-34,h:1.55,d:3.3,size:1.25,tilt:3,frame:'thin',caption:true,hidden:false,ar:1.5,assetId:'11111111-1111-4111-8111-111111111111',o:1},
 {id:'a2',type:'image',name:'Tall',az:120.5,h:1.7,d:3.1,size:1.1,tilt:0,frame:'plate',caption:false,hidden:true,ar:0.6,assetId:'22222222-2222-4222-8222-222222222222',o:2},
 {id:'t1',type:'text',name:'',az:10,h:2,d:3.3,size:1.6,tilt:0,frame:'none',caption:false,hidden:false,ar:2.4,text:{...SM.__text,body:'Hello dome',card:true},o:3},
 {id:'v1',type:'video',name:'vid',az:0,h:1,d:3,size:1,ar:1.7,o:4},
]};
let mirror = { schemaVersion:1, environment: SM.emptyEnv(), viewerAnchor:{position:[0,1.6,0],rotation:[0,0,0,1],roomId:null}, nodes:{}, ext:{} };
const ch = SM.diff(model, mirror);
ok(ch.some(c=>c.kind==='node.add'&&c.node.id==='a1'),'adds image node');
ok(!ch.some(c=>c.kind==='node.add'&&c.node.id==='v1'),'videos are not pushed');
const ops = SM.toOps(ch); ok(ops.length>0 && ops.every(o=>o.op),'ops built: '+ops.length);
for (const o of ops) if(o.op==='node.add'){ const n=o.node; ok(JSON.stringify(n.ext).length<4096,'ext size '+n.id+' '+JSON.stringify(n.ext).length); }
const bgn = ops.find(o=>o.op==='node.add'&&o.node.id==='mw-bg'); ok(!!bgn,'bg node'); console.log('  bg ext bytes',JSON.stringify(bgn.node.ext).length);
SM.applyWire(mirror, ch);
ok(SM.diff(model, mirror).length===0,'idempotent: no diff after apply');
const back = SM.fromScene(mirror, model);
ok(back.items.length===3,'3 items back (video stays local)');
const a1=back.items.find(i=>i.id==='a1'); ok(a1.az===-34&&a1.h===1.55&&a1.d===3.3&&a1.size===1.25&&a1.tilt===3&&a1.frame==='thin'&&a1.caption===true&&a1.ar===1.5,'a1 exact numbers survive');
const a2=back.items.find(i=>i.id==='a2'); ok(a2.az===120.5&&a2.hidden===true&&a2.frame==='plate'&&a2.ar===0.6&&a2.size===1.1,'a2 exact');
ok(a1.mediaId==='a_11111111-1111-4111-8111-111111111111','mediaId derived');
ok(back.items.find(i=>i.id==='t1').text.body==='Hello dome'&&back.items.find(i=>i.id==='t1').text.card===true,'text round trip');
ok(back.bg.preset==='glum'&&back.bg.top===model.bg.top,'bg round trip'); ok(back.view.dome===4.5,'dome');
// edit az
model.items[0].az = 50; model.items[0].name='Moon 2';
const c2 = SM.diff(model, mirror); console.log('  edit diff:',c2.map(c=>c.path||c.kind).join(', '));
ok(c2.every(c=>c.nodeId==='a1')&&c2.some(c=>c.path==='transform.position')&&c2.some(c=>c.path==='transform.rotation')&&c2.some(c=>c.path==='name')&&!c2.some(c=>c.path==='props.width'),'minimal edit diff');
// remove
model.items.splice(1,1); const c3=SM.diff(model, mirror); ok(c3.some(c=>c.kind==='node.remove'&&c.nodeId==='a2'),'remove detected');
// foreign nodes (e.g. made by the assistant or another client) : no ops until user touches them
const foreign = { id:'n_abc', type:'artwork', name:'Foreign', parentId:null, transform:{position:[2,1.4,-2],rotation:[0,0.3826834,0,0.9238795],scale:[1,1,1]}, visible:true, locked:false, props:{assetId:'33333333-3333-4333-8333-333333333333',width:1.2,height:0.8,fit:'contain',title:'Foreign',description:'',attribution:'',frame:{style:'modern',color:'#222222',width:0.05,depth:0.04,matColor:'#ffffff',matWidth:0}}, ext:{} };
mirror.nodes.n_abc = foreign;
const m2 = SM.fromScene(mirror, model); const f=m2.items.find(i=>i.id==='n_abc');
ok(f && Math.abs(f.az-45)<0.5 && Math.abs(f.d-2.828)<0.01 && f.frame==='plate' && Math.abs(f.ar-1.5)<1e-3,'foreign node read: az '+f.az+' d '+f.d);
model.items=m2.items; model.bg=m2.bg;
ok(SM.diff(model, mirror).filter(c=>c.nodeId==='n_abc').length===0,'foreign node untouched when not edited');
// env override from outside
mirror.environment.gradientTopColor='#ff0000'; ok(SM.fromScene(mirror).bg.top==='#ff0000','external sky colour wins');
// quaternion round trip
for (const [az,t] of [[0,0],[90,10],[-170,-20],[179,30]]) { const q=SM.quatOf(az,t), a=SM.anglesOf(q); ok(Math.abs(((a.yaw+az+540)%360)-180)<0.01 && Math.abs(a.tilt-t)<0.01,`quat ${az},${t}`); }
console.log(fails? 'FAILED '+fails : 'ALL OK'); process.exit(fails?1:0);
